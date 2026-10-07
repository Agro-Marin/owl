// @vitest-environment node
// The built package, as its users get it: built once here, then bundled with
// esbuild through the package's own exports and "sideEffects".
import { execFileSync, spawnSync } from "child_process";
import { build } from "esbuild";
import { readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");

beforeAll(() => {
  execFileSync(process.execPath, ["build.mjs"], { cwd: PACKAGE, stdio: "pipe" });
}, 60000);

async function bundle(code: string, minify = true): Promise<string> {
  const result = await build({
    stdin: { contents: code, resolveDir: PACKAGE, loader: "js" },
    bundle: true,
    format: "esm",
    minify,
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

// names a bundle keeps unminified, one per part of the runtime it holds
const COMPONENT_CODE = ["App", "TemplateSet", "ComponentNode", "Scheduler", "Fiber"];
const BLOCKDOM_CODE = ["createBlock", "VMulti", "VList", "VToggler", "createCatcher"];
const COMPILER_CODE = ["CodeGenerator", "parseXML", "compileExpr"];

describe.each(["@odoo/owl", "@odoo/owl/runtime"])("%s", (entry) => {
  test("importing it for its effects bundles nothing", async () => {
    expect(await bundle(`import ${JSON.stringify(entry)};`)).toBe("");
  });

  test("a bundle of signal alone holds no component, blockdom or compiler code", async () => {
    const all = await bundle(`export * from ${JSON.stringify(entry)};`);
    const signalOnly = await bundle(
      `import { signal } from ${JSON.stringify(entry)}; console.log(signal);`
    );
    const readable = await bundle(
      `import { signal } from ${JSON.stringify(entry)}; console.log(signal);`,
      false
    );
    for (const name of [...COMPONENT_CODE, ...BLOCKDOM_CODE, ...COMPILER_CODE]) {
      expect(readable).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    // measured, minified: 15.9 KB of 152.9 KB (full, 10.4 %), of 103.5 KB
    // (runtime, 15.4 %); signal brings its collections' proxies
    expect(signalOnly.length / all.length).toBeLessThan(0.2);
  });
});

test("importing the compiler module for its effects keeps its registration", async () => {
  const code = await bundle(`import "@odoo/owl/compiler";`, false);
  expect(code).toContain('Symbol.for("@odoo/owl/compiler")');
  expect(code).toMatch(/\bCodeGenerator\b/);
});

test("the build makes ES modules and IIFE scripts, no CommonJS", () => {
  const files = readdirSync(join(PACKAGE, "dist")).filter((name) => name.endsWith("js"));
  expect(files.sort()).toEqual([
    "owl.compiler.es.js",
    "owl.compiler.iife.js",
    "owl.es.js",
    "owl.iife.js",
    "owl.iife.min.js",
    "owl.runtime.es.js",
    "owl.runtime.iife.js",
    "owl.runtime.iife.min.js",
  ]);
});

describe("require()", () => {
  // Node's require() of an ES module (require(esm)): the very module import()
  // gives, so one process holds one owl however its code loads it
  test("each entry loads as the module import() gives, without a warning", () => {
    const script = `
      import { createRequire } from "node:module";
      const require = createRequire(process.cwd() + "/");
      const result = {};
      for (const entry of ["@odoo/owl", "@odoo/owl/runtime", "@odoo/owl/compiler"]) {
        const required = require(entry);
        const imported = await import(entry);
        result[entry] = [required === imported, Object.keys(required).length > 1];
      }
      console.log(JSON.stringify(result));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: PACKAGE,
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({
      "@odoo/owl": [true, true],
      "@odoo/owl/runtime": [true, true],
      "@odoo/owl/compiler": [true, true],
    });
  });
});
