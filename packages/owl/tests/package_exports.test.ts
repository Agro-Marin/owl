import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

describe("the package's exports", () => {
  // engines allows Node 20, whose require() cannot load an ES module before
  // 20.19: a module of the package that ESM can import, CommonJS can require
  test("every subpath that has an import condition has a require condition to a .cjs file", () => {
    const missing: string[] = [];
    for (const [subpath, conditions] of Object.entries<any>(pkg.exports)) {
      if (typeof conditions === "object" && conditions.import) {
        if (!(typeof conditions.require === "string" && conditions.require.endsWith(".cjs"))) {
          missing.push(subpath);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("a subpath's require condition comes before its default", () => {
    for (const conditions of Object.values<any>(pkg.exports)) {
      if (typeof conditions === "object" && conditions.require) {
        const keys = Object.keys(conditions);
        expect(keys.indexOf("require")).toBeLessThan(keys.indexOf("default"));
      }
    }
  });
});
