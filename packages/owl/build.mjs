import * as esbuild from "esbuild";
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const IIFE_FILENAME = "dist/owl.iife.js";
const CJS_FILENAME = "dist/owl.cjs";
const ES_FILENAME = "dist/owl.es.js";

if (pkg.module !== ES_FILENAME || pkg.main !== CJS_FILENAME) {
  throw new Error("package.json has been modified. Build script should be updated accordingly");
}

function getGitHash() {
  return execSync("git rev-parse --short HEAD").toString().trim();
}

function addSuffix(filename, suffix) {
  const parts = filename.split(".");
  parts.splice(parts.length - 1, 0, suffix);
  return parts.join(".");
}

const define = {
  __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  __BUILD_HASH__: JSON.stringify(getGitHash()),
};

// dist/owl.es.js -> dist/owl.<variant>.es.js
function variantName(filename, variant) {
  return filename.replace(/^dist\/owl\./, `dist/owl.${variant}.`);
}

async function buildVariant(entry, suffix) {
  const esm = suffix ? variantName(ES_FILENAME, suffix) : ES_FILENAME;
  const cjs = suffix ? variantName(CJS_FILENAME, suffix) : CJS_FILENAME;
  const iife = suffix ? variantName(IIFE_FILENAME, suffix) : IIFE_FILENAME;
  const iifeMin = addSuffix(iife, "min");

  const common = {
    entryPoints: [entry],
    bundle: true,
    define,
    target: "es2022",
    // Force owl-core to resolve to its built dist file. Without this, esbuild
    // picks up the `paths` mapping in owl-runtime/tsconfig.json and pulls
    // owl-core's source in addition to its dist via owl-compiler — bundling
    // owl-core twice.
    alias: {
      "@odoo/owl-core": "../owl-core/dist/owl-core.es.js",
    },
  };

  await Promise.all([
    esbuild.build({ ...common, outfile: esm, format: "esm" }),
    esbuild.build({ ...common, outfile: cjs, format: "cjs" }),
    esbuild.build({ ...common, outfile: iife, format: "iife", globalName: "owl" }),
    esbuild.build({ ...common, outfile: iifeMin, format: "iife", globalName: "owl", minify: true }),
  ]);
}

// dist/owl.compiler.es.js: the compiler for a page whose @odoo/owl is the
// runtime build. Everything it would share with the runtime is imported from
// @odoo/owl, never bundled: a second owl-core would be a second OwlError class.
async function buildCompilerModule() {
  const outfile = "dist/owl.compiler.es.js";
  await esbuild.build({
    entryPoints: ["src/compiler.ts"],
    bundle: true,
    define,
    target: "es2022",
    format: "esm",
    outfile,
    external: ["@odoo/owl"],
    alias: {
      "@odoo/owl-runtime": "@odoo/owl",
      "@odoo/owl-core": "./src/compiler_core.ts",
    },
  });
  const code = readFileSync(outfile, "utf-8");
  if (/class OwlError\b/.test(code) || !code.includes('from "@odoo/owl"')) {
    throw new Error(`${outfile} must import the runtime from @odoo/owl, not bundle owl-core`);
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
}
