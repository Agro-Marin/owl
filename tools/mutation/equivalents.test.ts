import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../workspace.mjs";
import {
  isEquivalent,
  LINE_TOLERANCE,
  loadEquivalents,
  staleEquivalents,
  writeEquivalentLines,
} from "./equivalents.mjs";

const base = { tool: "stryker", file: "f.ts", operator: "BooleanLiteral" };

test("an equivalent mutant is matched a few lines from where it was written, and the line is saved", () => {
  const dir = scratchDir("owl-equivalents-test");
  const path = join(dir, "equivalent.json");
  try {
    writeFileSync(
      path,
      JSON.stringify([
        { ...base, line: 10, original: "true", replacement: "false", reason: "r1" },
        { ...base, line: 40, original: "true", replacement: "false", reason: "r2" },
        { ...base, line: 70, original: "x", replacement: "y", reason: "r3" },
      ])
    );
    const equivalents = loadEquivalents(path);
    // the same text twice, both moved down by 3: each takes the nearest entry
    expect(
      isEquivalent(equivalents, { ...base, line: 43, original: "true", replacement: "false" })
    ).toBe(true);
    expect(
      isEquivalent(equivalents, { ...base, line: 13, original: "true", replacement: "false" })
    ).toBe(true);
    // a third identical mutant has no entry left
    expect(
      isEquivalent(equivalents, { ...base, line: 20, original: "true", replacement: "false" })
    ).toBe(false);
    // too far away to be the same mutant
    expect(
      isEquivalent(equivalents, {
        ...base,
        line: 70 + LINE_TOLERANCE + 1,
        original: "x",
        replacement: "y",
      })
    ).toBe(false);
    expect(staleEquivalents(equivalents, ["f.ts"], ["stryker"]).map((e) => e.reason)).toEqual([
      "r3",
    ]);
    expect(writeEquivalentLines(path)).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8")).map((e: any) => e.line)).toEqual([13, 43, 70]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
