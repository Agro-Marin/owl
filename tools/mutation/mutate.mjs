import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../workspace.mjs";
import { runCustom } from "./custom.mjs";
import { loadEquivalents, staleEquivalents, writeEquivalentLines } from "./equivalents.mjs";
import { runStryker } from "./stryker.mjs";
import { PACKAGES, REPORTS, packageOf } from "./targets.mjs";

const USAGE = `npm run mutate -- [--mutate <file>]... [--stryker | --custom] [--incremental [--force]]
  [--concurrency <n>] [--operator <path|receiver|swap>]... [--line <n>]

Mutation testing of the four core files (tools/mutation/targets.mjs): Stryker's standard
mutators (vitest runner, per-test coverage) and OWL's own operators (tools/mutation/operators.mjs:
property-path and receiver substitution, adjacent statement swaps). Reports under temp/mutation/;
survivors not listed in tools/mutation/equivalent.json make it exit 1.`;

const { values } = parseArgs({
  options: {
    mutate: { type: "string", multiple: true },
    stryker: { type: "boolean", default: false },
    custom: { type: "boolean", default: false },
    incremental: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    concurrency: { type: "string" },
    operator: { type: "string", multiple: true },
    line: { type: "string", multiple: true },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const files = (values.mutate || Object.values(PACKAGES).flatMap((pkg) => pkg.files)).map((file) =>
  relative(ROOT, resolve(process.cwd(), file))
);
for (const file of files) {
  packageOf(file);
}
const tools = values.stryker || values.custom ? values : { stryker: true, custom: true };
const concurrency = values.concurrency ? Number(values.concurrency) : undefined;
const lines = values.line?.map(Number);

const results = [];
for (const pkg of Object.keys(PACKAGES)) {
  const mutate = files.filter((file) => packageOf(file) === pkg);
  if (!mutate.length) {
    continue;
  }
  if (tools.stryker) {
    const options = { mutate, incremental: values.incremental, force: values.force, concurrency };
    for (const summary of await runStryker(pkg, options)) {
      results.push({ tool: "stryker", ...summary });
    }
  }
  if (tools.custom) {
    const options = { mutate, concurrency, operators: values.operator, lines };
    for (const summary of await runCustom(pkg, options)) {
      results.push({ tool: "custom", ...summary });
    }
  }
}

mkdirSync(REPORTS, { recursive: true });
writeFileSync(join(REPORTS, "summary.json"), JSON.stringify(results, null, 2) + "\n");

console.log("\nMutation summary (score excludes equivalent mutants)");
for (const r of results) {
  console.log(
    `  ${r.tool.padEnd(8)} ${r.file.padEnd(48)} killed ${r.killed}, survived ${r.survived}, ` +
      `equivalent ${r.equivalent}${r.invalid ? `, invalid ${r.invalid}` : ""}, score ${r.score.toFixed(2)} %`
  );
}
const survivors = results.flatMap((r) => r.survivors);
if (survivors.length) {
  console.log(`\n${survivors.length} surviving mutant(s):`);
  for (const s of survivors) {
    const what = `${s.original.replace(/\s+/g, " ").slice(0, 90)} -> ${s.replacement.replace(/\s+/g, " ").slice(0, 90)}`;
    console.log(
      `  ${s.file}:${s.line} [${s.tool} ${s.operator}${s.status === "NoCoverage" ? ", no coverage" : ""}] ${what}`
    );
  }
}
const full = !values.line && !values.operator;
const stale = full
  ? staleEquivalents(
      loadEquivalents(),
      files,
      results.map((r) => r.tool)
    )
  : [];
for (const entry of stale) {
  console.log(
    `  stale equivalent (matches no surviving mutant): ${entry.file}:${entry.line} ${entry.operator}`
  );
}
if (full) {
  const moved = writeEquivalentLines();
  if (moved) {
    console.log(
      `  ${moved} equivalent(s) found a few lines from where they were written: lines updated`
    );
  }
}
console.log(`\nReports: ${relative(ROOT, REPORTS)}/`);
process.exitCode = survivors.length ? 1 : 0;
