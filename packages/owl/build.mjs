import * as esbuild from "esbuild";
import { execFileSync } from "child_process";
import { createRequire } from "node:module";
import { debuglog, parseArgs } from "node:util";
import { buildDate, buildHash } from "./build_hash.mjs";
import { TARGET } from "./build_target.mjs";
import { checkNodeVersion, PACKAGE_SOURCES } from "../../tools/workspace.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { join, relative, resolve } from "path";

checkNodeVersion();

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
const log = debuglog("owl-build");

if (pkg.main !== "dist/owl.es.js") {
  throw new Error("package.json has been modified. Build script should be updated accordingly");
}

const {
  values: { outdir },
  positionals: [target],
} = parseArgs({
  allowPositionals: true,
  options: { outdir: { type: "string", default: "dist" } },
});

const hash = buildHash("../..");
const define = {
  __BUILD_DATE__: JSON.stringify(buildDate("../..", hash)),
  __BUILD_HASH__: JSON.stringify(hash),
};

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

const BUILT_FILE = /^owl\.[\w.-]*js$/;

const common = { bundle: true, define, target: TARGET, format: "esm", alias: PACKAGE_SOURCES };

const COMPILER_INPUTS = [
  /^packages\/owl-compiler\/src\//,
  /^packages\/owl\/src\/compiler(_core)?\.ts$/,
  /^packages\/owl-core\/src\/(owl_error|event_modifiers)\.ts$/,
  /^packages\/owl-runtime\/src\/(version|build_info)\.ts$/,
];

async function buildCompilerModule() {
  const result = await esbuild.build({
    ...common,
    entryPoints: ["src/compiler.ts"],
    outfile: join(outdir, "owl.compiler.es.js"),
    alias: { ...PACKAGE_SOURCES, "@odoo/owl-core": "./src/compiler_core.ts" },
    metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
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
    if (
      target.includes("*") ||
      target.startsWith("./dist/types/") ||
      !target.startsWith("./dist/")
    ) {
      continue;
    }
    if (!existsSync(join(outdir, target.slice("./dist/".length)))) {
      throw new Error(`package.json exports ${target}, which the build does not make`);
    }
  }
}

function buildTypes() {
  mkdirSync(join(outdir, "types"), { recursive: true });
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
        join(outdir, "types", `${name}.d.ts`),
        `src/${entry}.ts`,
        "--no-banner",
        "--inline-declare-global",
      ],
      { stdio: "inherit" }
    );
  }
}

switch (target) {
  case "types":
    buildTypes();
    break;
  default:
    for (const file of existsSync(outdir) ? readdirSync(outdir, { withFileTypes: true }) : []) {
      if (file.isFile() && BUILT_FILE.test(file.name)) {
        rmSync(join(outdir, file.name));
      }
    }
    log("build %s, %s, into %s", define.__BUILD_HASH__, define.__BUILD_DATE__, outdir);
    await esbuild.build({
      ...common,
      entryPoints: ["src/index.ts"],
      outfile: join(outdir, "owl.es.js"),
      plugins: [bundledCompilerPlugin],
    });
    await esbuild.build({
      ...common,
      entryPoints: ["src/runtime.ts"],
      outfile: join(outdir, "owl.runtime.es.js"),
    });
    await buildCompilerModule();
    checkExportedFiles();
}
