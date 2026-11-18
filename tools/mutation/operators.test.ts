import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateMutants } from "./operators.mjs";
import { ROOT } from "../workspace.mjs";

const replacements = (source: string, operator: string) =>
  generateMutants(source, "probe.ts", [operator]).map((m) => m.text);

describe("OWL mutation operators", () => {
  test("path drops one inner segment of a member chain", () => {
    expect(replacements("f(a.b!.c.d);", "path")).toEqual(["f(a.c.d);", "f(a.b!.d);"]);
  });

  test("path drops a segment of the path a const alias stands for", () => {
    const source = "class F { render() { const root = this.root!; return root.node.app; } }";
    expect(replacements(source, "path")).toContain(
      "class F { render() { const root = this.root!; return this.node.app; } }"
    );
  });

  test("receiver substitutes a local that is read with the same property elsewhere", () => {
    const source = "function f(a, b) { g(b.x); return a.x.y; }";
    expect(replacements(source, "receiver")).toEqual([
      "function f(a, b) { g(a.x); return a.x.y; }",
      "function f(a, b) { g(b.x); return b.x.y; }",
    ]);
  });

  test("receiver ignores module-level names and globals", () => {
    const source = "const m = new Map(); function f(k) { return Reflect.get(k) || m.get(k); }";
    expect(replacements(source, "receiver")).toEqual([]);
  });

  test("swap exchanges two adjacent statements of a block, not declarations", () => {
    const source = "function f() { a(); b(); function g() {} }";
    expect(replacements(source, "swap")).toEqual(["function f() { b(); a(); function g() {} }"]);
  });

  test("swap skips a literal declaration the other statement does not name", () => {
    const source = "function f() { let n = 0; g(); let m = 1; h(m); }";
    expect(replacements(source, "swap")).toEqual([
      "function f() { let n = 0; g(); h(m); let m = 1; }",
    ]);
  });

  test("debug output is left to Stryker", () => {
    const source = [
      'import { debug, debugLog } from "./debug";',
      'function f(a) { if (debug.x) { debugLog("x", a.b.c); } a.b.c(); debugLog("y"); }',
    ].join("\n");
    const mutants = generateMutants(source, "probe.ts");
    expect(mutants.map((m) => [m.operator, m.replacement])).toEqual([["path", "a.c"]]);
  });

  test("the ef4e3258 mutant of fibers.ts is generated", () => {
    const file = "packages/owl-runtime/src/rendering/fibers.ts";
    const mutants = generateMutants(readFileSync(join(ROOT, file), "utf8"), file, ["path"]);
    expect(mutants.map((m) => [m.original, m.replacement])).toContainEqual([
      "root.node.app.scheduler",
      "this.node.app.scheduler",
    ]);
  });
});
