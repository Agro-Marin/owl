import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

function targets(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : Object.values(value as object).flatMap((v) => targets(v));
}

describe("the package's exports", () => {
  // owl keeps module state (scheduler, reactive graph, debug flags): a CommonJS
  // twin of an entry would be a second owl in a process that both requires and
  // imports it. Node's require() loads the ES modules themselves.
  test("every entry is an ES module, for import and require alike", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("dist/owl.es.js");
    expect(pkg.module).toBeUndefined();
    const all = [pkg.main, ...targets(pkg.exports)];
    expect(all.filter((target) => /\.c[jt]s$/.test(target))).toEqual([]);
    for (const conditions of Object.values<any>(pkg.exports)) {
      if (typeof conditions === "object") {
        expect(Object.keys(conditions)).toEqual(["types", "default"]);
      }
    }
  });
});

describe("the workspace", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf-8"));
  const PACKAGES = [
    "package.json",
    "packages/owl/package.json",
    "packages/owl-core/package.json",
    "packages/owl-compiler/package.json",
    "packages/owl-runtime/package.json",
    "tools/playground/package.json",
  ];

  test("every package, and the toolchain, is on Node 26", () => {
    expect(PACKAGES.map((path) => [path, read(path).engines?.node])).toEqual(
      PACKAGES.map((path) => [path, ">=26"])
    );
    for (const file of [".node-version", ".nvmrc"]) {
      expect(readFileSync(join(ROOT, file), "utf-8")).toBe("26\n");
    }
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(26);
  });

  // their code is bundled into @odoo/owl from its sources: published, they
  // would be packages of raw TypeScript
  test("only @odoo/owl is published", () => {
    expect(PACKAGES.filter((path) => !read(path).private)).toEqual(["packages/owl/package.json"]);
  });
});
