import * as esbuild from "esbuild";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, mkdirSync } from "fs";
import { relative, resolve } from "path";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const IIFE_FILENAME = "dist/owl.iife.js";
const CJS_FILENAME = "dist/owl.cjs";
const ES_FILENAME = "dist/owl.es.js";

if (pkg.module !== ES_FILENAME || pkg.main !== CJS_FILENAME) {
  throw new Error("package.json has been modified. Build script should be updated accordingly");
}

const SOURCES = ["owl-core", "owl-compiler", "owl-runtime", "owl"].map((p) => `packages/${p}/src`);

function git(command) {
  return execSync(`git ${command}`, { cwd: "../..", stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

// The build's name: the commit, with a digest of the uncommitted changes to the
// sources when there are any. Odoo keys its persistent cache of compiled
// templates on it, and the compiler module must be of the runtime's build: two
// builds of different code must not share a name.
function getBuildHash() {
  let commit;
  try {
    commit = git("rev-parse --short=8 HEAD");
  } catch {
    return "nogit";
  }
  const changes =
    git(`diff HEAD -- ${SOURCES.join(" ")}`) +
    git(`ls-files --others --exclude-standard -- ${SOURCES.join(" ")}`);
  if (!changes) {
    return commit;
  }
  const untracked = git(`ls-files --others --exclude-standard -- ${SOURCES.join(" ")}`)
    .split("\n")
    .filter(Boolean)
    .map((file) => readFileSync(resolve("../..", file), "utf-8"))
    .join("\n");
  const digest = createHash("sha256").update(changes).update(untracked).digest("hex");
  return `${commit}-dirty-${digest.slice(0, 8)}`;
}

function addSuffix(filename, suffix) {
  const parts = filename.split(".");
  parts.splice(parts.length - 1, 0, suffix);
  return parts.join(".");
}

const define = {
  __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  __BUILD_HASH__: JSON.stringify(getBuildHash()),
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

async function buildVariant(entry, suffix) {
  const esm = suffix ? variantName(ES_FILENAME, suffix) : ES_FILENAME;
  const cjs = suffix ? variantName(CJS_FILENAME, suffix) : CJS_FILENAME;
  const iife = suffix ? variantName(IIFE_FILENAME, suffix) : IIFE_FILENAME;
  const iifeMin = addSuffix(iife, "min");

  const common = { entryPoints: [entry], bundle: true, define, target: "es2022", alias };

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

// dist/owl.compiler.es.js (and .iife.js): the compiler for a page whose owl is
// the runtime build. It imports nothing: it registers itself under a global
// key the runtime reads, and the runtime checks that it is of its own build.
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
    esbuild.build({ ...common, format: "iife", outfile: "dist/owl.compiler.iife.js" }),
  ]);
  for (const input of Object.keys(results[0].metafile.inputs)) {
    const path = relative("../..", resolve(input));
    if (!COMPILER_INPUTS.some((re) => re.test(path))) {
      throw new Error(`the compiler module must not bundle ${path}: it would be a second copy`);
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
}
