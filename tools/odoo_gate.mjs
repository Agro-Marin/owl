import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  compareRuns,
  findEnvironment,
  firstBad,
  groupByAddon,
  hootTestTag,
  parseRun,
} from "./odoo_gate_lib.mjs";
import { checkNodeVersion, defaultOdoo, ROOT, scratchDir, workspaceDir } from "./workspace.mjs";
import { addOwlWorktree, removeWorktree } from "./worktree.mjs";

const FILES = ["owl.es.js", "owl.runtime.es.js", "owl.compiler.es.js"];
const DEFAULT_SUITES = "/web:WebSuite,/web:MobileWebSuite,/mail:MailSuite,/mail:MobileMailSuite";
const USAGE = `usage:
  node tools/odoo_gate.mjs [--old <build>] [--new <build>] [--suites <tags>] [--odoo <path>] [--keep]
  node tools/odoo_gate.mjs --bisect <suite tag> --test <HOOT test name> --good <rev> --bad <rev>
A build is "vendored" (Odoo's web/static/lib/owl), "worktree" (this checkout as it is) or a git revision.`;

const { values } = parseArgs({
  options: {
    old: { type: "string", default: "vendored" },
    new: { type: "string", default: "worktree" },
    suites: { type: "string", default: DEFAULT_SUITES },
    odoo: { type: "string" },
    keep: { type: "boolean", default: false },
    bisect: { type: "string" },
    test: { type: "string" },
    good: { type: "string" },
    bad: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
checkNodeVersion();

const odoo = resolve(values.odoo ?? defaultOdoo() ?? "");
if (!existsSync(join(odoo, "addons/web"))) {
  console.error(`no Odoo checkout at ${odoo}: pass --odoo <path>\n${USAGE}`);
  process.exit(2);
}
const workspace = workspaceDir();
const environment = findEnvironment(workspace);
if (!environment) {
  console.error(`no <env>.conf beside an <env>/bin/python in ${workspace}`);
  process.exit(2);
}
const siblings = ["design-themes", "l10n", "agromarin"]
  .map((name) => join(workspace, name))
  .filter((path) => existsSync(path));
const scratch = scratchDir("odoo-gate");
const databases = [];
const worktrees = [];
const log = (line) => console.log(`[odoo-gate] ${line}`);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function prepareBuild(spec, label) {
  const out = join(scratch, `build-${label}`);
  mkdirSync(out, { recursive: true });
  if (spec === "vendored") {
    for (const file of FILES) {
      copyFileSync(join(odoo, "addons/web/static/lib/owl", file), join(out, file));
    }
  } else if (spec === "worktree") {
    execFileSync(process.execPath, ["build.mjs", "--outdir", out], {
      cwd: join(ROOT, "packages/owl"),
      stdio: ["ignore", "ignore", "inherit"],
    });
  } else {
    const commit = git(ROOT, "rev-parse", "--verify", `${spec}^{commit}`);
    const tree = join(scratch, `owl-${commit.slice(0, 8)}`);
    addOwlWorktree(ROOT, tree, commit);
    try {
      execFileSync(process.execPath, ["build.mjs", "--outdir", out], {
        cwd: join(tree, "packages/owl"),
        stdio: ["ignore", "ignore", "inherit"],
      });
    } finally {
      removeWorktree(ROOT, tree);
    }
  }
  const hash = /var buildHash = "([^"]*)"/.exec(readFileSync(join(out, "owl.es.js"), "utf8"))?.[1];
  log(`build ${label} (${spec}): ${hash}`);
  return { dir: out, hash };
}

function prepareOdoo(label) {
  const dir = join(scratch, `odoo-${label}`);
  git(odoo, "worktree", "add", "--detach", dir, "HEAD");
  worktrees.push(dir);
  symlinkSync(join(odoo, "node_modules"), join(dir, "node_modules"));
  // The shared native extension is fresh for the working tree of the checkout it
  // was built from: give the worktree the same crate sources.
  cpSync(join(odoo, "crates"), join(dir, "crates"), {
    recursive: true,
    force: true,
    filter: (source) => !source.split("/").includes("target"),
  });
  return dir;
}

function useBuild(odooDir, build) {
  for (const file of FILES) {
    copyFileSync(join(build.dir, file), join(odooDir, "addons/web/static/lib/owl", file));
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function odooBin(odooDir, args, logFile, onLine) {
  return new Promise((done) => {
    const fd = openSync(logFile, "w");
    const child = spawn(
      environment.python,
      [
        join(odooDir, "odoo-bin"),
        "-c",
        environment.conf,
        `--addons-path=${[join(odooDir, "addons"), ...siblings].join(",")}`,
        ...args,
      ],
      { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] }
    );
    const write = (chunk) => {
      writeSync(fd, chunk);
      if (onLine) {
        onLine(chunk.toString());
      }
    };
    child.stdout.on("data", write);
    child.stderr.on("data", write);
    child.on("close", (status) => {
      closeSync(fd);
      done(status);
    });
  });
}

async function createDatabase(odooDir, label, addon) {
  const db = `owlgate_${process.pid}_${label}_${addon}`;
  databases.push({ db, odooDir });
  const logFile = join(scratch, `install-${label}-${addon}.log`);
  const status = await odooBin(
    odooDir,
    ["-d", db, "-i", addon, "--stop-after-init", "--no-http"],
    logFile
  );
  if (status !== 0) {
    throw new Error(`installing ${addon} in ${db} failed (exit ${status}): see ${logFile}`);
  }
  return db;
}

async function runTests(odooDir, db, tags, logFile) {
  const port = await freePort();
  let served = null;
  let asked = false;
  const status = await odooBin(
    odooDir,
    ["-d", db, "--test-tags", tags, "--http-port", String(port), "--stop-after-init"],
    logFile,
    (text) => {
      if (!asked && text.includes("HTTP service running")) {
        asked = true;
        fetch(`http://127.0.0.1:${port}/web/static/lib/owl/owl.runtime.es.js`)
          .then((response) => response.text())
          .then((body) => (served = /var buildHash = "([^"]*)"/.exec(body)?.[1] ?? null))
          .catch(() => {});
      }
    }
  );
  return { status, served, run: parseRun(readFileSync(logFile, "utf8")) };
}

function printList(title, items) {
  if (items.length) {
    console.log(`  ${title} (${items.length}):`);
    for (const item of items) {
      console.log(`    ${item}`);
    }
  }
}

async function compare() {
  const groups = groupByAddon(
    values.suites
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
  );
  const builds = { old: prepareBuild(values.old, "old"), new: prepareBuild(values.new, "new") };
  const trees = { old: prepareOdoo("old"), new: prepareOdoo("new") };
  useBuild(trees.old, builds.old);
  useBuild(trees.new, builds.new);
  let regressions = 0;
  for (const [addon, tags] of groups) {
    log(`${addon}: installing in two scratch databases`);
    const [oldDb, newDb] = await Promise.all([
      createDatabase(trees.old, "old", addon),
      createDatabase(trees.new, "new", addon),
    ]);
    log(`${addon}: running ${tags.join(", ")} on both builds`);
    const [before, after] = await Promise.all([
      runTests(trees.old, oldDb, tags.join(","), join(scratch, `tests-old-${addon}.log`)),
      runTests(trees.new, newDb, tags.join(","), join(scratch, `tests-new-${addon}.log`)),
    ]);
    for (const [side, result, build] of [
      ["old", before, builds.old],
      ["new", after, builds.new],
    ]) {
      if (result.served !== build.hash) {
        throw new Error(
          `${addon} ${side}: the server served build ${result.served}, not ${build.hash}`
        );
      }
    }
    const difference = compareRuns(before.run, after.run);
    console.log(
      `${addon}: old ${before.run.outcomes.size} HOOT outcomes (${before.run.result}), ` +
        `new ${after.run.outcomes.size} (${after.run.result})`
    );
    printList("REGRESSIONS (failed only on the new build)", difference.regressions);
    printList("Python-side failures only on the new build", difference.pythonRegressions);
    printList("fixed (failed only on the old build)", difference.fixed);
    printList("Python-side failures only on the old build", difference.pythonFixed);
    printList("only run on the old build", difference.onlyBefore);
    printList("only run on the new build", difference.onlyAfter);
    regressions += difference.regressions.length + difference.pythonRegressions.length;
  }
  console.log(regressions ? `${regressions} regression(s)` : "no regression");
  return regressions ? 1 : 0;
}

async function bisect() {
  if (!values.test || !values.good || !values.bad) {
    console.error(USAGE);
    return 2;
  }
  const tag = hootTestTag(values.bisect, values.test);
  const addon = [...groupByAddon([values.bisect]).keys()][0];
  const candidates = git(ROOT, "rev-list", "--reverse", `${values.good}..${values.bad}`)
    .split("\n")
    .filter(Boolean);
  if (!candidates.length) {
    console.error(`no commit in ${values.good}..${values.bad}`);
    return 2;
  }
  const tree = prepareOdoo("bisect");
  const db = await createDatabase(tree, "bisect", addon);
  const isBad = async (rev) => {
    const build = prepareBuild(rev, `bisect-${rev.slice(0, 8)}`);
    useBuild(tree, build);
    const { served, run } = await runTests(
      tree,
      db,
      tag,
      join(scratch, `bisect-${rev.slice(0, 8)}.log`)
    );
    if (served !== build.hash) {
      throw new Error(`${rev}: the server served build ${served}, not ${build.hash}`);
    }
    const outcomes = [...run.outcomes].filter(([key]) => key.endsWith(` › ${values.test}`));
    if (!outcomes.length) {
      throw new Error(`${rev}: the test ${JSON.stringify(values.test)} did not run`);
    }
    const bad = outcomes.some(([, status]) => status === "failed");
    log(`${rev.slice(0, 10)} ${bad ? "bad" : "good"}`);
    return bad;
  };
  if (await isBad(values.good)) {
    console.error(`${values.good} fails the test already: it is not good`);
    return 2;
  }
  if (!(await isBad(candidates.at(-1)))) {
    console.error(`${values.bad} passes the test: it is not bad`);
    return 2;
  }
  const culprit = await firstBad(candidates, isBad);
  console.log(`first bad commit: ${git(ROOT, "log", "-1", "--format=%h %s", culprit)}`);
  return 0;
}

function cleanUp() {
  if (values.keep) {
    log(`kept: ${scratch}, databases ${databases.map(({ db }) => db).join(", ")}`);
    return;
  }
  for (const { db, odooDir } of databases) {
    try {
      execFileSync(
        environment.python,
        [join(odooDir, "odoo-bin"), "db", "-c", environment.conf, "drop", db],
        { cwd: workspace, stdio: "ignore" }
      );
    } catch {
      log(`could not drop ${db}: drop it with odoo-bin db drop`);
    }
  }
  for (const dir of worktrees) {
    git(odoo, "worktree", "remove", "--force", dir);
  }
  rmSync(scratch, { recursive: true, force: true });
}

try {
  process.exitCode = values.bisect ? await bisect() : await compare();
} catch (error) {
  console.error(`[odoo-gate] ${error.message}`);
  process.exitCode = 2;
} finally {
  cleanUp();
}
