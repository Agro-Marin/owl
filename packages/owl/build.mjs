import * as esbuild from "esbuild";
import { execSync } from "child_process";
import { buildHash } from "./build_hash.mjs";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join, relative, resolve } from "path";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const IIFE_FILENAME = "dist/owl.iife.js";
const CJS_FILENAME = "dist/owl.cjs";
const ES_FILENAME = "dist/owl.es.js";

if (pkg.module !== ES_FILENAME || pkg.main !== CJS_FILENAME) {
  throw new Error("package.json has been modified. Build script should be updated accordingly");
}

function addSuffix(filename, suffix) {
  const parts = filename.split(".");
  parts.splice(parts.length - 1, 0, suffix);
  return parts.join(".");
}

const define = {
  __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  __BUILD_HASH__: JSON.stringify(buildHash("../..")),
};

// every package from its sources: one copy of each in a bundle
const alias = {
  "@odoo/owl-core": "../owl-core/src/index.ts",
  "@odoo/owl-compiler": "../owl-compiler/src/index.ts",
  "@odoo/owl-runtime": "../owl-runtime/src/index.ts",
};

// dist/owl.es.js -> dist/owl.<variant>.es.js
function variantName(filename, variant) {
  return filename.replace(/^dist\/owl\./, `dist/owl.${variant}.`);
}

// the full build carries its compiler as owl-runtime's bundled compiler: a
// value the TemplateSet reads, not a registration run on import
const BUNDLED_COMPILER = resolve("src/bundled_compiler.ts");
const bundledCompilerPlugin = {
  name: "bundled-compiler",
  setup(build) {
    build.onResolve({ filter: /^\.\/bundled_compiler$/ }, (args) =>
      args.importer.endsWith(join("owl-runtime", "src", "template_set.ts"))
        ? { path: BUNDLED_COMPILER }
        : undefined
    );
  },
};

async function buildVariant(entry, suffix) {
  const esm = suffix ? variantName(ES_FILENAME, suffix) : ES_FILENAME;
  const cjs = suffix ? variantName(CJS_FILENAME, suffix) : CJS_FILENAME;
  const iife = suffix ? variantName(IIFE_FILENAME, suffix) : IIFE_FILENAME;
  const iifeMin = addSuffix(iife, "min");

  const plugins = suffix ? [] : [bundledCompilerPlugin];
  const common = { entryPoints: [entry], bundle: true, define, target: "es2022", alias, plugins };

  await Promise.all([
    esbuild.build({ ...common, outfile: esm, format: "esm" }),
    esbuild.build({ ...common, outfile: cjs, format: "cjs" }),
    esbuild.build({ ...common, outfile: iife, format: "iife", globalName: "owl" }),
    esbuild.build({ ...common, outfile: iifeMin, format: "iife", globalName: "owl", minify: true }),
  ]);
}

// the only sources the compiler module may bundle: the compiler, and the
// stateless classes and constants it takes from owl-core and owl-runtime
const COMPILER_INPUTS = [
  /^packages\/owl-compiler\/src\//,
  /^packages\/owl\/src\/compiler(_core)?\.ts$/,
  /^packages\/owl-core\/src\/(owl_error|event_modifiers)\.ts$/,
  /^packages\/owl-runtime\/src\/(version|build_info)\.ts$/,
];

// dist/owl.compiler.es.js (and .cjs, .iife.js): the compiler for a page whose
// owl is the runtime build. It imports nothing: it registers itself under a
// global key the runtime reads, and the runtime checks that it is of its own
// build. The .cjs is for require() on a Node that cannot require an ES module
// (before 20.19; engines allows 20).
async function buildCompilerModule() {
  const common = {
    entryPoints: ["src/compiler.ts"],
    bundle: true,
    define,
    target: "es2022",
    alias: { ...alias, "@odoo/owl-core": "./src/compiler_core.ts" },
    metafile: true,
  };
  const results = await Promise.all([
    esbuild.build({ ...common, format: "esm", outfile: "dist/owl.compiler.es.js" }),
    esbuild.build({ ...common, format: "cjs", outfile: "dist/owl.compiler.cjs" }),
    esbuild.build({ ...common, format: "iife", outfile: "dist/owl.compiler.iife.js" }),
  ]);
  for (const input of results.flatMap((result) => Object.keys(result.metafile.inputs))) {
    const path = relative("../..", resolve(input));
    if (!COMPILER_INPUTS.some((re) => re.test(path))) {
      throw new Error(`the compiler module must not bundle ${path}: it would be a second copy`);
    }
  }
}

// every file package.json exports, but the types (`build types`), is built
function checkExportedFiles() {
  const targets = Object.values(pkg.exports).flatMap((target) =>
    typeof target === "string" ? [target] : Object.values(target)
  );
  for (const target of targets) {
    if (!target.includes("*") && !target.startsWith("./dist/types/") && !existsSync(target)) {
      throw new Error(`package.json exports ${target}, which the build does not make`);
    }
  }
}

function buildTypes() {
  mkdirSync("dist/types", { recursive: true });
  execSync(
    "npx dts-bundle-generator --project tsconfig.types.json -o dist/types/owl.d.ts src/index.ts --no-banner",
    { stdio: "inherit" }
  );
  execSync(
    "npx dts-bundle-generator --project tsconfig.types.json -o dist/types/compiler.d.ts src/compiler.ts --no-banner",
    { stdio: "inherit" }
  );
}

const target = process.argv[2];

switch (target) {
  case "types":
    buildTypes();
    break;
  default:
    await buildVariant("src/index.ts");
    await buildVariant("src/runtime.ts", "runtime");
    await buildCompilerModule();
    checkExportedFiles();
}
