import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "../workspace.mjs";
import { isEquivalent, loadEquivalents } from "./equivalents.mjs";
import { PACKAGES, REPORTS } from "./targets.mjs";

export const SANDBOX_KEEP = [
  ".node-version",
  "package.json",
  "tsconfig.base.json",
  "packages/owl-core",
  "packages/owl-compiler",
  "packages/owl-runtime",
  "tools/workspace.mjs",
  "tools/testing",
];

export function strykerOptions(pkg, { mutate, incremental = false, force = false, concurrency }) {
  const reports = join(REPORTS, pkg);
  return {
    testRunner: "vitest",
    vitest: { configFile: join(PACKAGES[pkg].dir, "vitest.config.ts"), related: true },
    coverageAnalysis: "perTest",
    mutate: mutate || PACKAGES[pkg].files,
    ignorePatterns: ["/*", "/tools/*", ...SANDBOX_KEEP.map((path) => `!/${path}`)],
    tempDirName: join("temp", "stryker-tmp", pkg),
    concurrency,
    timeoutMS: 20000,
    dryRunTimeoutMinutes: 30,
    incremental,
    force,
    incrementalFile: join(reports, "incremental.json"),
    reporters: ["clear-text", "progress-append-only", "html", "json"],
    clearTextReporter: { allowEmojis: false, logTests: false, maxTestsToLog: 0 },
    htmlReporter: { fileName: join(reports, "index.html") },
    jsonReporter: { fileName: join(reports, "report.json") },
    plugins: ["@stryker-mutator/vitest-runner"],
    cleanTempDir: true,
  };
}

export async function runStryker(pkg, options) {
  const { Stryker } = await import("@stryker-mutator/core");
  const stryker = new Stryker(strykerOptions(pkg, options));
  await stryker.runMutationTest();
  return summarizeStryker(pkg, options.mutate);
}

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

export function summarizeStryker(pkg, mutate) {
  const report = JSON.parse(readFileSync(join(REPORTS, pkg, "report.json"), "utf8"));
  const equivalents = loadEquivalents();
  const summary = [];
  for (const [path, entry] of Object.entries(report.files)) {
    const file = relative(ROOT, join(ROOT, path));
    if (mutate && !mutate.includes(file)) {
      continue;
    }
    const lines = entry.source.split("\n");
    const counts = { killed: 0, survived: 0, equivalent: 0, invalid: 0 };
    const survivors = [];
    for (const mutant of entry.mutants) {
      const { start, end } = mutant.location;
      const candidate = {
        tool: "stryker",
        file,
        line: start.line,
        operator: mutant.mutatorName,
        original: sliceSource(lines, start, end),
        replacement: mutant.replacement,
      };
      if (DETECTED.has(mutant.status)) {
        counts.killed++;
      } else if (UNDETECTED.has(mutant.status)) {
        if (isEquivalent(equivalents, candidate)) {
          counts.equivalent++;
        } else {
          counts.survived++;
          survivors.push({ ...candidate, status: mutant.status });
        }
      } else {
        counts.invalid++;
      }
    }
    const scored = counts.killed + counts.survived;
    const raw = counts.killed + counts.survived + counts.equivalent;
    summary.push({
      file,
      ...counts,
      score: scored ? (100 * counts.killed) / scored : 100,
      rawScore: raw ? (100 * counts.killed) / raw : 100,
      survivors: survivors.sort((a, b) => a.line - b.line),
    });
  }
  return summary;
}

function sliceSource(lines, start, end) {
  if (start.line === end.line) {
    return lines[start.line - 1].slice(start.column - 1, end.column - 1);
  }
  return [
    lines[start.line - 1].slice(start.column - 1),
    ...lines.slice(start.line, end.line - 1),
    lines[end.line - 1].slice(0, end.column - 1),
  ].join("\n");
}
