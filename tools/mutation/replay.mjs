import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../workspace.mjs";
import { SANDBOX_KEEP } from "./stryker.mjs";
import { PACKAGES, REPORTS, packageOf } from "./targets.mjs";

const USAGE = `node tools/mutation/replay.mjs --file <target> [--from <line>] [--to <line>] [--line <n>]... [--all]
  [--report <stryker report.json>] [--name <sandbox>] [--] [test files...]

Replays Stryker's surviving mutants of one file (from its last report, or --report) one at a
time against the given test files of the package (default: all), in a sandbox copy of the
checkout taken now, so the working tree is never mutated. For triage: write a test, replay.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string" },
    from: { type: "string", default: "1" },
    to: { type: "string", default: "100000" },
    line: { type: "string", multiple: true },
    all: { type: "boolean", default: false },
    report: { type: "string" },
    name: { type: "string", default: String(process.pid) },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.file) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
const file = values.file;
const pkg = packageOf(file);
const config = PACKAGES[pkg];
const report = JSON.parse(readFileSync(values.report || join(REPORTS, pkg, "report.json"), "utf8"));
const entry = Object.entries(report.files).find(([path]) => path.endsWith(file))[1];
const sandbox = join(ROOT, "temp", "mutation-replay", values.name);
rmSync(sandbox, { recursive: true, force: true });
for (const path of SANDBOX_KEEP) {
  cpSync(join(ROOT, path), join(sandbox, path), {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
}
mkdirSync(sandbox, { recursive: true });
symlinkSync(join(ROOT, "node_modules"), join(sandbox, "node_modules"));
const target = join(sandbox, file);
const source = readFileSync(target, "utf8");
if (source !== entry.source) {
  console.log(`warning: ${file} differs from the report's source; locations may be off`);
}
const lines = source.split("\n");
const offset = (l, c) => lines.slice(0, l - 1).reduce((a, x) => a + x.length + 1, 0) + c - 1;
const mutants = entry.mutants.filter(
  (m) =>
    m.location.start.line >= Number(values.from) &&
    m.location.start.line <= Number(values.to) &&
    (!values.line || values.line.map(Number).includes(m.location.start.line)) &&
    (values.all || m.status === "Survived" || m.status === "NoCoverage")
);
let survived = 0;
for (const m of mutants) {
  const start = offset(m.location.start.line, m.location.start.column);
  const end = offset(m.location.end.line, m.location.end.column);
  writeFileSync(target, source.slice(0, start) + m.replacement + source.slice(end));
  const args = [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--bail", "1"];
  if (config.project) {
    args.push("--project", config.project);
  }
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [...args, ...positionals], {
      cwd: join(sandbox, config.dir),
      stdio: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  const what = `${source.slice(start, end).replace(/\s+/g, " ").slice(0, 70)} -> ${m.replacement.replace(/\s+/g, " ").slice(0, 50)}`;
  survived += code === 0 ? 1 : 0;
  console.log(
    `${code === 0 ? "SURVIVED" : "killed  "} ${m.location.start.line} ${m.mutatorName}: ${what}`
  );
}
writeFileSync(target, source);
rmSync(sandbox, { recursive: true, force: true });
console.log(`${mutants.length - survived} killed, ${survived} survived`);
