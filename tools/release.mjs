import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uncommittedChanges } from "./vendor_odoo.mjs";
import { checkNodeVersion, ROOT } from "./workspace.mjs";

export const PACKAGES = ["owl", "owl-compiler", "owl-core", "owl-runtime"];
export const VERSION_FILE = "packages/owl-runtime/src/version.ts";
export const CHANGELOG = "doc/v3/owl/changelog_marin.md";
// The upstream release commit the fork starts from (`[REL] v3.0.0-alpha.49`).
export const FORK_BASE = "4bd42fe7";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// Semver precedence (https://semver.org/#spec-item-11).
export function compareVersions(a, b) {
  const [x, y] = [VERSION_RE.exec(a), VERSION_RE.exec(b)];
  if (!x || !y) {
    throw new Error(`not a version: ${!x ? a : b}`);
  }
  for (let i = 1; i <= 3; i++) {
    if (Number(x[i]) !== Number(y[i])) {
      return Number(x[i]) - Number(y[i]);
    }
  }
  if (!x[4] || !y[4]) {
    return (x[4] ? -1 : 0) + (y[4] ? 1 : 0);
  }
  const [p, q] = [x[4].split("."), y[4].split(".")];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) {
      return p[i] === undefined ? -1 : 1;
    }
    const [m, n] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (m && n && Number(p[i]) !== Number(q[i])) {
      return Number(p[i]) - Number(q[i]);
    }
    if (m !== n) {
      return m ? -1 : 1;
    }
    if (!m && p[i] !== q[i]) {
      return p[i] < q[i] ? -1 : 1;
    }
  }
  return 0;
}

export function changelogSection(version, date, subjects) {
  const groups = new Map();
  for (const subject of subjects) {
    const tag = /^\[([A-Z]+)\]/.exec(subject)?.[1] ?? "OTHER";
    groups.getOrInsertComputed(tag, () => []).push(subject.replace(/^\[[A-Z]+\]\s*/, ""));
  }
  const order = ["FIX", "IMP", "PERF", "REF", "ADD", "REM"];
  const tags = [...groups.keys()].sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)
  );
  const lines = [`## ${version} (${date})`, ""];
  for (const tag of tags) {
    lines.push(`### ${tag}`, "", ...groups.get(tag).map((subject) => `- ${subject}`), "");
  }
  return lines.join("\n");
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function isAncestor(root, ancestor, commit) {
  try {
    git(root, "merge-base", "--is-ancestor", ancestor, commit);
    return true;
  } catch {
    return false;
  }
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function release({ root = ROOT, version, date, base = FORK_BASE, log = console.log }) {
  if (!VERSION_RE.test(version)) {
    throw new Error(`${version} is not a version (e.g. 3.0.0-marin.1)`);
  }
  const changes = uncommittedChanges(root);
  if (changes.length) {
    throw new Error(
      `refusing to release: the checkout differs from its commit (${changes.join(", ")})`
    );
  }
  const current = /version = "([^"]+)"/.exec(readFileSync(join(root, VERSION_FILE), "utf8"))[1];
  if (compareVersions(version, current) <= 0) {
    throw new Error(`refusing to release ${version}: it does not follow ${current}`);
  }
  writeFileSync(join(root, VERSION_FILE), `export const version = "${version}";\n`);
  for (const name of PACKAGES) {
    const path = join(root, "packages", name, "package.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.version = version;
    for (const deps of [data.dependencies, data.devDependencies]) {
      for (const dep of Object.keys(deps ?? {})) {
        if (dep.startsWith("@odoo/owl")) {
          deps[dep] = version;
        }
      }
    }
    writeJson(path, data);
  }
  const lockPath = join(root, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    for (const name of PACKAGES) {
      const entry = lock.packages?.[`packages/${name}`];
      if (!entry) {
        continue;
      }
      entry.version = version;
      for (const deps of [entry.dependencies, entry.devDependencies]) {
        for (const dep of Object.keys(deps ?? {})) {
          if (dep.startsWith("@odoo/owl")) {
            deps[dep] = version;
          }
        }
      }
    }
    writeJson(lockPath, lock);
  }
  const previous = git(root, "tag", "--list", "v*", "--sort=-v:refname")
    .split("\n")
    .find((tag) => tag && isAncestor(root, tag, "HEAD"));
  const since = previous ?? base;
  const subjects = git(root, "log", "--format=%s", `${since}..HEAD`).split("\n").filter(Boolean);
  const changelogPath = join(root, CHANGELOG);
  const existing = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8").replace(/^# .*\n\n?/, "")
    : "";
  mkdirSync(dirname(changelogPath), { recursive: true });
  writeFileSync(
    changelogPath,
    `# Changelog of the 3.0-marin fork\n\n${changelogSection(version, date, subjects)}\n${existing}`
  );
  const files = [
    VERSION_FILE,
    ...PACKAGES.map((name) => `packages/${name}/package.json`),
    ...(existsSync(lockPath) ? ["package-lock.json"] : []),
    CHANGELOG,
  ];
  git(root, "add", "--", CHANGELOG);
  git(
    root,
    "commit",
    "-q",
    "-m",
    `[REL] v${version}\n\n${subjects.length} commit(s) since ${since}; ${CHANGELOG} lists them.`,
    "--",
    ...files
  );
  git(root, "tag", "-a", `v${version}`, "-m", `v${version}`);
  log(
    `released v${version}: ${subjects.length} commit(s) since ${since}; tagged v${version} (push it with the branch: git push origin 3.0-marin v${version})`
  );
}

if (import.meta.main) {
  checkNodeVersion();
  const [version] = process.argv.slice(2);
  if (!version) {
    console.error("usage: npm run release -- <version>  (e.g. 3.0.0-marin.1)");
    process.exit(2);
  }
  try {
    release({ version, date: new Date().toISOString().slice(0, 10) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
