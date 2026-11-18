import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OUTCOME_RE =
  /(\w+\.test_\w+)\.browser: \[HOOT\] Test (["'])(.*)\2 (passed|failed|errored|skipped|timed out)\b/;
const PYTHON_FAIL_RE = /(?:FAIL|ERROR): (\w+\.test_\w+)/;
const RESULT_RE = /tests\.result: (.*)$/;

// One test-tag group per addon: the guide's "one database per suite".
export function groupByAddon(tags) {
  const groups = new Map();
  for (const tag of tags) {
    const match = /^\/(\w+):/.exec(tag);
    if (!match) {
      throw new Error(`test tag ${JSON.stringify(tag)} does not name an addon (/<addon>:<Class>)`);
    }
    groups.getOrInsertComputed(match[1], () => []).push(tag);
  }
  return groups;
}

export function parseRun(log) {
  const outcomes = new Map();
  const pythonFailures = new Set();
  let result = null;
  for (const line of log.split("\n")) {
    const outcome = OUTCOME_RE.exec(line);
    if (outcome) {
      const [, runner, , name, status] = outcome;
      const key = `${runner} › ${name}`;
      if (outcomes.get(key) !== "failed") {
        outcomes.set(key, status === "timed out" || status === "errored" ? "failed" : status);
      }
      continue;
    }
    const failure = PYTHON_FAIL_RE.exec(line);
    if (failure && line.includes("ERROR")) {
      pythonFailures.add(failure[1]);
    }
    const summary = RESULT_RE.exec(line);
    if (summary) {
      result = summary[1].trim();
    }
  }
  return { outcomes, pythonFailures, result };
}

export function compareRuns(before, after) {
  const regressions = [];
  const fixed = [];
  const onlyBefore = [];
  const onlyAfter = [];
  for (const [name, status] of after.outcomes) {
    const previous = before.outcomes.get(name);
    if (previous === undefined) {
      onlyAfter.push(`${name} (${status})`);
    } else if (status !== previous && status === "failed") {
      regressions.push(name);
    } else if (status !== previous && previous === "failed") {
      fixed.push(name);
    }
  }
  for (const [name, status] of before.outcomes) {
    if (!after.outcomes.has(name)) {
      onlyBefore.push(`${name} (${status})`);
    }
  }
  const pythonRegressions = [...after.pythonFailures].filter(
    (name) => !before.pythonFailures.has(name)
  );
  const pythonFixed = [...before.pythonFailures].filter((name) => !after.pythonFailures.has(name));
  return {
    regressions: regressions.sort(),
    fixed: fixed.sort(),
    onlyBefore: onlyBefore.sort(),
    onlyAfter: onlyAfter.sort(),
    pythonRegressions: pythonRegressions.sort(),
    pythonFixed: pythonFixed.sort(),
  };
}

// candidates: the commits after the good one, oldest first, the last one known bad.
export async function firstBad(candidates, isBad) {
  let low = 0;
  let high = candidates.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (await isBad(candidates[middle])) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return candidates[low];
}

// A workspace pairs <env>.conf with <env>/bin/python.
export function findEnvironment(workspace) {
  for (const entry of readdirSync(workspace).sort()) {
    if (!entry.endsWith(".conf")) {
      continue;
    }
    const python = join(workspace, entry.slice(0, -".conf".length), "bin/python");
    if (existsSync(python)) {
      return { conf: join(workspace, entry), python };
    }
  }
  return null;
}

export function hootTestTag(suiteTag, testName) {
  if (testName.includes(",")) {
    throw new Error(
      `the HOOT test name ${JSON.stringify(testName)} holds a comma, which a test tag's parameters cannot carry`
    );
  }
  return `${suiteTag}[${testName}]`;
}
