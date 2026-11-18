import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRules, specificationErrors, testTitles } from "./spec_check.mjs";
import { scratchDir } from "./workspace.mjs";

test("a rule is a top-level bullet with its continuation lines, outside fenced code", () => {
  const rules = parseRules(
    [
      "# Title",
      "",
      "Intro text, not a rule.",
      "",
      "- **First** rule [test: a.test.ts › one]",
      "  continued [test: b.test.ts › two]",
      "- Second rule",
      "",
      "```md",
      "- not a rule",
      "```",
    ].join("\n")
  );
  expect(rules).toEqual([
    {
      line: 5,
      text: "**First** rule [test: a.test.ts › one] continued [test: b.test.ts › two]",
      tests: [
        { file: "a.test.ts", title: "one" },
        { file: "b.test.ts", title: "two" },
      ],
    },
    { line: 7, text: "Second rule", tests: [] },
  ]);
});

test("the titles of a test file include each, skip, only, and titles broken over lines", () => {
  const titles = testTitles(
    [
      `test("plain", () => {});`,
      `it('with it', () => {});`,
      "test.each([[1]])(`%s each`, () => {});",
      `test.skip("skipped", () => {});`,
      `test(\n  "a long title\n   broken by prettier",\n  () => {}\n);`,
      `test("an \\"escaped\\" quote", () => {});`,
    ].join("\n")
  );
  expect([...titles]).toEqual([
    "plain",
    "with it",
    "%s each",
    "skipped",
    "a long title broken by prettier",
    'an "escaped" quote',
  ]);
});

test("a rule naming no test, a missing file or a missing test is an error", () => {
  const root = scratchDir("owl-spec-check-test");
  try {
    mkdirSync(join(root, "t"));
    writeFileSync(join(root, "t/a.test.ts"), `test("exists", () => {});`);
    const { rules, references, errors } = specificationErrors(
      [
        "- good [test: t/a.test.ts › exists]",
        "- untested",
        "- gone [test: t/b.test.ts › exists]",
        "- renamed [test: t/a.test.ts › was renamed]",
      ].join("\n"),
      root
    );
    expect({ rules, references }).toEqual({ rules: 4, references: 3 });
    expect(errors).toEqual([
      "line 2: the rule names no test",
      "line 3: t/b.test.ts does not exist",
      'line 4: t/a.test.ts declares no test "was renamed"',
    ]);
    expect(specificationErrors("no bullets", root).errors).toEqual([
      "the specification states no rule",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
