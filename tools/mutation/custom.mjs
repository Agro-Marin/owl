import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import { ROOT } from "../workspace.mjs";
import { isEquivalent, loadEquivalents } from "./equivalents.mjs";
import { OPERATORS, generateMutants } from "./operators.mjs";
import { SANDBOX_KEEP } from "./stryker.mjs";
import { PACKAGES, REPORTS } from "./targets.mjs";

const VITEST = join(ROOT, "node_modules/vitest/vitest.mjs");
const SOURCE_DIRS = [
  "packages/owl-core/src",
  "packages/owl-compiler/src",
  "packages/owl-runtime/src",
];

export async function runCustom(pkg, { mutate, concurrency, operators = OPERATORS, lines }) {
  const config = PACKAGES[pkg];
  const reports = join(REPORTS, pkg);
  mkdirSync(reports, { recursive: true });
  const workers = concurrency || Math.max(2, Math.floor(availableParallelism() / 4));
  const threads = Math.max(1, Math.floor(availableParallelism() / workers));

  const coverage = await coverageMap(pkg, workers, threads);
  const equivalents = loadEquivalents();
  const pending = [];
  const results = [];
  for (const file of mutate) {
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const mutant of generateMutants(source, file, operators)) {
      if (lines && !lines.includes(mutant.line)) {
        continue;
      }
      const entry = { tool: "custom", file, ...mutant };
      if (isEquivalent(equivalents, entry)) {
        results.push({ ...describe(entry), status: "Equivalent" });
        continue;
      }
      const tests = coveringTests(coverage, file, source, mutant);
      if (!tests.length) {
        results.push({ ...describe(entry), status: "NoCoverage" });
        continue;
      }
      pending.push({ entry, tests });
    }
  }

  const sandboxes = Array.from({ length: Math.min(workers, pending.length) }, (_, i) =>
    makeSandbox(pkg, i)
  );
  console.log(
    `custom operators, ${pkg}: ${pending.length} mutant(s) to run, ${results.length} settled, ` +
      `${sandboxes.length} sandbox(es) x ${threads} vitest worker(s)`
  );
  if (sandboxes.length) {
    const tests = [...new Set(pending.flatMap((job) => job.tests))];
    const baseline = await runVitest(sandboxes[0], config, tests, availableParallelism(), 1800000);
    if (baseline.code !== 0) {
      throw new Error(`the unmutated sandbox fails its tests:\n${baseline.output.slice(-3000)}`);
    }
    console.log(`  unmutated sandbox: ${tests.length} test file(s) pass in ${baseline.ms} ms`);
  }
  let done = 0;
  const started = Date.now();
  await Promise.all(
    sandboxes.map(async (sandbox) => {
      for (let job = pending.shift(); job; job = pending.shift()) {
        const { entry, tests } = job;
        const target = join(sandbox, entry.file);
        writeFileSync(target, entry.text);
        const budget = tests.reduce((sum, t) => sum + coverage.durations[t], 0);
        const timeout = 60000 + (3 * budget) / Math.min(threads, tests.length);
        const run = await runVitest(sandbox, config, tests, threads, timeout);
        writeFileSync(target, readFileSync(join(ROOT, entry.file)));
        const status = run.timedOut ? "Timeout" : run.code === 0 ? "Survived" : "Killed";
        results.push({ ...describe(entry), status, tests: tests.length, ms: run.ms });
        done++;
        if (status === "Survived" || done % 25 === 0) {
          const where = `${entry.file}:${entry.line}`;
          console.log(
            `  [${done}/${done + pending.length}] ${Math.round((Date.now() - started) / 1000)}s ` +
              (status === "Survived" ? `survived ${where} ${entry.operator}` : "")
          );
        }
      }
    })
  );
  for (const sandbox of sandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }

  const reportFile = join(reports, "custom.json");
  const previous = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : [];
  const key = (r) => `${r.file}:${r.operator}:${r.line}:${r.original}:${r.replacement}`;
  const fresh = new Set(results.map(key));
  const merged = lines || operators !== OPERATORS ? previous.filter((r) => !fresh.has(key(r))) : [];
  writeFileSync(reportFile, JSON.stringify([...merged, ...results], null, 2) + "\n");
  return mutate.map((file) => summarize(file, results));
}

function describe({ tool, file, line, operator, original, replacement }) {
  return { tool, file, line, operator, original, replacement };
}

function summarize(file, results) {
  const mine = results.filter((r) => r.file === file);
  const count = (...statuses) => mine.filter((r) => statuses.includes(r.status)).length;
  const killed = count("Killed", "Timeout");
  const survived = count("Survived", "NoCoverage");
  const equivalent = count("Equivalent");
  return {
    file,
    killed,
    survived,
    equivalent,
    invalid: 0,
    score: killed + survived ? (100 * killed) / (killed + survived) : 100,
    survivors: mine
      .filter((r) => r.status === "Survived" || r.status === "NoCoverage")
      .sort((a, b) => a.line - b.line),
  };
}

function makeSandbox(pkg, index) {
  const sandbox = join(ROOT, "temp", "mutation-sandboxes", `${pkg}-${index}`);
  rmSync(sandbox, { recursive: true, force: true });
  for (const path of SANDBOX_KEEP) {
    cpSync(join(ROOT, path), join(sandbox, path), {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
  }
  symlinkSync(join(ROOT, "node_modules"), join(sandbox, "node_modules"));
  return sandbox;
}

function runVitest(root, config, tests, threads, timeout, { bail = true, extra = [] } = {}) {
  const args = [VITEST, "run", "--maxWorkers", String(threads), "--reporter", "dot"];
  if (bail) {
    args.push("--bail", "1");
  }
  if (config.project) {
    args.push("--project", config.project);
  }
  args.push(...extra, ...tests);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: join(root, config.dir),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
      detached: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output = (output + chunk).slice(-20000)));
    child.stderr.on("data", (chunk) => (output = (output + chunk).slice(-20000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill(-child.pid, "SIGKILL");
    }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output, ms: Date.now() - started });
    });
  });
}

// Which test files run which statements of the targets: vitest with v8 coverage, one test file
// at a time, cached per test file under temp/mutation/<pkg>/coverage-map.json and recomputed
// when that test file or any source changes.
async function coverageMap(pkg, workers, threads) {
  const config = PACKAGES[pkg];
  const cacheFile = join(REPORTS, pkg, "coverage-map.json");
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const testFiles = listTests(config);
  const shared = hashFiles([
    ...SOURCE_DIRS.flatMap((dir) => walk(join(ROOT, dir))),
    ...walk(join(ROOT, config.dir, "tests")).filter((f) => !f.endsWith(".test.ts")),
  ]);
  const todo = testFiles.filter((t) => cache[t]?.hash !== hashOf(shared, t, config));
  if (todo.length) {
    console.log(`custom operators, ${pkg}: coverage of ${todo.length} test file(s)`);
  }
  const queue = [...todo];
  const scratch = join(REPORTS, pkg, "coverage-runs");
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async (_, worker) => {
      for (let test = queue.shift(); test; test = queue.shift()) {
        const dir = join(scratch, String(worker));
        rmSync(dir, { recursive: true, force: true });
        const run = await runVitest(ROOT, config, [test], threads, 600000, {
          bail: false,
          extra: [
            "--coverage.enabled",
            "--coverage.provider=v8",
            "--coverage.reporter=json",
            `--coverage.reportsDirectory=${dir}`,
            ...config.files.map((f) => `--coverage.include=${relative(config.dir, f)}`),
          ],
        });
        if (run.code !== 0) {
          throw new Error(`coverage run of ${test} failed:\n${run.output.slice(-3000)}`);
        }
        const report = JSON.parse(readFileSync(join(dir, "coverage-final.json"), "utf8"));
        const statements = {};
        for (const [path, data] of Object.entries(report)) {
          statements[relative(ROOT, path)] = Object.entries(data.statementMap).map(([id, loc]) => [
            loc.start.line,
            loc.start.column,
            loc.end.line,
            loc.end.column,
            data.s[id],
          ]);
        }
        cache[test] = { hash: hashOf(shared, test, config), ms: run.ms, statements };
      }
    })
  );
  rmSync(scratch, { recursive: true, force: true });
  for (const test of Object.keys(cache)) {
    if (!testFiles.includes(test)) {
      delete cache[test];
    }
  }
  writeFileSync(cacheFile, JSON.stringify(cache));
  const durations = Object.fromEntries(testFiles.map((t) => [t, cache[t].ms]));
  return { tests: testFiles, cache, durations };
}

function listTests(config) {
  const dir = join(ROOT, config.dir);
  const all = walk(join(dir, "tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => relative(dir, f));
  return config.project === "dom" ? all.filter((f) => f !== "tests/no_dom.test.ts") : all;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

function hashFiles(files) {
  const hash = createHash("sha1");
  for (const file of files) {
    hash.update(file).update(readFileSync(file));
  }
  return hash.digest("hex");
}

function hashOf(shared, test, config) {
  return createHash("sha1")
    .update(shared)
    .update(readFileSync(join(ROOT, config.dir, test)))
    .digest("hex");
}

// The test files that execute the statement a mutant changes: the innermost statement holding
// its start, by the coverage of the unmutated source. A swap changes two statements; either
// running is enough.
function coveringTests(coverage, file, source, mutant) {
  const points = mutant.anchors.map((pos) => lineColumn(source, pos));
  return coverage.tests.filter((test) => {
    const statements = coverage.cache[test].statements[file];
    if (!statements) {
      return false;
    }
    return points.some((point) => {
      let best = null;
      for (const s of statements) {
        if (contains(s, point) && (!best || span(s) < span(best))) {
          best = s;
        }
      }
      return best ? best[4] > 0 : statements.some((s) => s[4] > 0);
    });
  });
}

function lineColumn(source, pos) {
  const before = source.slice(0, pos);
  const line = before.split("\n").length;
  return { line, column: pos - before.lastIndexOf("\n") - 1 };
}

function contains([sl, sc, el, ec], { line, column }) {
  return (
    (sl < line || (sl === line && sc <= column)) && (el > line || (el === line && ec > column))
  );
}

function span([sl, sc, el, ec]) {
  return (el - sl) * 100000 + (ec - sc);
}
