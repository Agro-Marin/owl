import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkNodeVersion, ROOT } from "./workspace.mjs";

export const SPECIFICATION = "doc/v3/owl/specification.md";

const REFERENCE_RE = /\[test: ([^\]›]+?) › ([^\]]+?)\]/g;
const TITLE_RE =
  /\b(?:test|it)(?:\.(?:each|skip|only)(?:\([\s\S]*?\))?)?\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

// The rules of a specification: each top-level bullet, its continuation lines
// joined, outside fenced code.
export function parseRules(markdown) {
  const rules = [];
  let current = null;
  let fenced = false;
  markdown.split("\n").forEach((line, index) => {
    if (line.startsWith("```")) {
      fenced = !fenced;
      current = null;
      return;
    }
    if (fenced) {
      return;
    }
    if (line.startsWith("- ")) {
      current = { line: index + 1, text: line.slice(2) };
      rules.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.text += " " + line.trim();
    } else {
      current = null;
    }
  });
  return rules.map(({ line, text }) => ({
    line,
    text,
    tests: [...text.matchAll(REFERENCE_RE)].map(([, file, title]) => ({
      file: file.trim(),
      title: title.trim(),
    })),
  }));
}

// The titles a test file declares (test, it, their .each, .skip and .only),
// whitespace collapsed as prettier may break a long title over lines.
export function testTitles(source) {
  return new Set(
    [...source.matchAll(TITLE_RE)].map(([, , title]) =>
      title.replace(/\\(["'`])/g, "$1").replace(/\s+/g, " ")
    )
  );
}

export function specificationErrors(markdown, root = ROOT) {
  const errors = [];
  const titles = new Map();
  const rules = parseRules(markdown);
  if (!rules.length) {
    errors.push("the specification states no rule");
  }
  for (const rule of rules) {
    if (!rule.tests.length) {
      errors.push(`line ${rule.line}: the rule names no test`);
    }
    for (const { file, title } of rule.tests) {
      if (!titles.has(file)) {
        const path = join(root, file);
        titles.set(file, existsSync(path) ? testTitles(readFileSync(path, "utf8")) : null);
      }
      const declared = titles.get(file);
      if (!declared) {
        errors.push(`line ${rule.line}: ${file} does not exist`);
      } else if (!declared.has(title)) {
        errors.push(`line ${rule.line}: ${file} declares no test "${title}"`);
      }
    }
  }
  return { rules: rules.length, references: rules.flatMap((r) => r.tests).length, errors };
}

if (import.meta.main) {
  checkNodeVersion();
  const { rules, references, errors } = specificationErrors(
    readFileSync(join(ROOT, SPECIFICATION), "utf8")
  );
  for (const error of errors) {
    console.error(`${SPECIFICATION}: ${error}`);
  }
  console.log(`${rules} rules, ${references} test references, ${errors.length} errors`);
  process.exitCode = errors.length ? 1 : 0;
}
