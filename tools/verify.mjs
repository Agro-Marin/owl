import { spawn, spawnSync } from "node:child_process";
import { closeSync, globSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkNodeVersion, ROOT, scratchDir } from "./workspace.mjs";

const PACKAGES = ["owl-core", "owl-compiler", "owl-runtime", "owl"];
const CODEMODS = globSync("tools/odoo_migration/*.py", { cwd: ROOT });
const RUFF = ["ruff", "/home/marin/Odoo/p314o19m/bin/ruff"].find(
  (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0
);
const npm = (...args) => ["npm", ["run", ...args]];

const STEPS = [
  ...PACKAGES.map((name) => [`test ${name}`, npm("test", "-w", `packages/${name}`)]),
  ["test:tools", npm("test:tools")],
  ...PACKAGES.map((name) => [`types ${name}`, npm("test:types", "-w", `packages/${name}`)]),
  ["types tools", npm("test:types:tools")],
  ["lint", npm("lint")],
  ["check-formatting", npm("check-formatting")],
  ["build", npm("build")],
  ["build:types", npm("build:types")],
  ["build:devtools", npm("build:devtools")],
  ["build:playground", npm("build:playground")],
  ["build:doc", npm("build:doc")],
  ["build:doc-v2", npm("build:doc-v2")],
  [
    "codemods parse",
    [
      "python3",
      ["-c", "import ast, sys\nfor f in sys.argv[1:]: ast.parse(open(f).read(), f)", ...CODEMODS],
    ],
  ],
  [
    "codemods ruff F,E9",
    RUFF && [RUFF, ["check", "--isolated", "--no-cache", "--select", "F,E9", ...CODEMODS]],
  ],
];

function run([command, args], log) {
  return new Promise((resolve) => {
    const fd = openSync(log, "w");
    const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", fd, fd] });
    child.on("close", (status) => {
      closeSync(fd);
      resolve(status);
    });
    child.on("error", () => {
      closeSync(fd);
      resolve(127);
    });
  });
}

checkNodeVersion();
const only = process.argv.slice(2);
const logs = scratchDir("verify");
const results = [];
for (const [name, command] of STEPS) {
  if (only.length && !only.some((filter) => name.includes(filter))) {
    continue;
  }
  if (!command) {
    results.push({ name, result: "skipped", seconds: 0 });
    console.log(`${name}: skipped (no ruff on PATH)`);
    continue;
  }
  const log = join(logs, `${name.replace(/[^\w-]+/g, "_")}.log`);
  const start = performance.now();
  const status = await run(command, log);
  const seconds = (performance.now() - start) / 1000;
  results.push({ name, result: status === 0 ? "pass" : "FAIL", seconds, log });
  console.log(
    `${name}: ${status === 0 ? "pass" : `FAIL (exit ${status})`} in ${seconds.toFixed(1)}s`
  );
  if (status !== 0) {
    console.log(readFileSync(log, "utf8").split("\n").slice(-40).join("\n"));
  }
}

const width = Math.max(...results.map(({ name }) => name.length));
console.log(`\n${"step".padEnd(width)}  result   seconds`);
for (const { name, result, seconds } of results) {
  console.log(`${name.padEnd(width)}  ${result.padEnd(7)}  ${seconds.toFixed(1).padStart(7)}`);
}
const failed = results.filter(({ result }) => result === "FAIL");
const total = results.reduce((sum, { seconds }) => sum + seconds, 0);
console.log(
  `${results.length - failed.length} of ${results.length} steps passed (or skipped) in ${total.toFixed(0)}s; logs in ${logs}`
);
process.exitCode = failed.length ? 1 : 0;
