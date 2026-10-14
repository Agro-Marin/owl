import * as esbuild from "esbuild";
import { execFileSync } from "child_process";
import { createRequire } from "node:module";
import { debuglog } from "node:util";
import { buildHash } from "./build_hash.mjs";
import { TARGET } from "./build_target.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { join, relative, resolve } from "path";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
const log = debuglog("owl-build");

const ES_FILENAME = "dist/owl.es.js";

if (pkg.main !== ES_FILENAME) {
  throw new Error("package.json has been modified. Build script should be updated accordingly");
}

const define = {
  __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  __BUILD_HASH__: JSON.stringify(buildHash("../..")),
};

const alias = {
  "@odoo/owl-core": "../owl-core/src/index.ts",
  "@odoo/owl-compiler": "../owl-compiler/src/index.ts",
  "@odoo/owl-runtime": "../owl-runtime/src/index.ts",
};

function variantName(filename, variant) {
  return filename.replace(/^dist\/owl\./, `dist/owl.${variant}.`);
}

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

  const plugins = suffix ? [] : [bundledCompilerPlugin];
  const common = { entryPoints: [entry], bundle: true, define, target: TARGET, alias, plugins };

  await esbuild.build({ ...common, outfile: esm, format: "esm" });
}

const COMPILER_INPUTS = [
  /^packages\/owl-compiler\/src\//,
  /^packages\/owl\/src\/compiler(_core)?\.ts$/,
  /^packages\/owl-core\/src\/(owl_error|event_modifiers)\.ts$/,
  /^packages\/owl-runtime\/src\/(version|build_info)\.ts$/,
];

async function buildCompilerModule() {
  const common = {
    entryPoints: ["src/compiler.ts"],
    bundle: true,
    define,
    target: TARGET,
    alias: { ...alias, "@odoo/owl-core": "./src/compiler_core.ts" },
    metafile: true,
  };
  const results = await Promise.all([
    esbuild.build({ ...common, format: "esm", outfile: "dist/owl.compiler.es.js" }),
  ]);
  for (const input of results.flatMap((result) => Object.keys(result.metafile.inputs))) {
    const path = relative("../..", resolve(input));
    if (!COMPILER_INPUTS.some((re) => re.test(path))) {
      throw new Error(`the compiler module must not bundle ${path}: it would be a second copy`);
    }
  }
}

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
  const cli = createRequire(import.meta.url).resolve(
    "dts-bundle-generator/dist/bin/dts-bundle-generator.js"
  );
  for (const [name, entry] of [
    ["owl", "index"],
    ["compiler", "compiler"],
  ]) {
    log("types %s using %s", name, process.execPath);
    execFileSync(
      process.execPath,
      [
        cli,
        "--project",
        "tsconfig.types.json",
        "-o",
        `dist/types/${name}.d.ts`,
        `src/${entry}.ts`,
        "--no-banner",
        "--inline-declare-global",
      ],
      { stdio: "inherit" }
    );
  }
}

const target = process.argv[2];

switch (target) {
  case "types":
    buildTypes();
    break;
  default:
    for (const file of existsSync("dist") ? readdirSync("dist", { withFileTypes: true }) : []) {
      if (file.isFile()) {
        rmSync(join("dist", file.name));
      }
    }
    await buildVariant("src/index.ts");
    await buildVariant("src/runtime.ts", "runtime");
    await buildCompilerModule();
    checkExportedFiles();
}
