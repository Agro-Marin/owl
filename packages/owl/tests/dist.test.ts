import { spawnSync } from "child_process";
import { build, transform } from "esbuild";
import { readdirSync, readFileSync } from "fs";
import { TARGET } from "../build_target.mjs";
import { join } from "path";
import { PACKAGE_SOURCES } from "../../../tools/workspace.mjs";
import { PACKAGE, removeScratchPackage, scratchPackage } from "./scratch_build";

let BUILT: string;

beforeAll(() => {
  BUILT = scratchPackage("owl-dist-test");
}, 60000);

afterAll(() => removeScratchPackage(BUILT));

async function bundle(code: string, minify = true): Promise<string> {
  const result = await build({
    stdin: { contents: code, resolveDir: BUILT, loader: "js" },
    bundle: true,
    format: "esm",
    minify,
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

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
    expect(signalOnly.length / all.length).toBeLessThan(0.2);
  });
});

test("importing the compiler module for its effects keeps its registration", async () => {
  const code = await bundle(`import "@odoo/owl/compiler";`, false);
  expect(code).toContain('Symbol.for("@odoo/owl/compiler")');
  expect(code).toMatch(/\bCodeGenerator\b/);
});

test("the build makes ES modules only: no IIFE script, no CommonJS", () => {
  const files = readdirSync(join(BUILT, "dist")).filter((name) => name.endsWith("js"));
  expect(files.sort()).toEqual(["owl.compiler.es.js", "owl.es.js", "owl.runtime.es.js"]);
});

describe("require()", () => {
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
      cwd: BUILT,
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

type Engine = "chrome" | "firefox" | "safari" | "node";
interface Api {
  api: string;
  calls: RegExp;
  support: Record<Engine, number | false>;
  present: () => boolean;
}
const APIS: Api[] = [
  {
    api: "Map/WeakMap getOrInsert, getOrInsertComputed",
    calls: /\.getOrInsert(Computed)?\(/,
    support: { chrome: 145, firefox: 144, safari: 26.2, node: 26 },
    present: () => typeof (Map.prototype as any).getOrInsertComputed === "function",
  },
  {
    api: "Promise.withResolvers",
    calls: /\bPromise\.withResolvers\(/,
    support: { chrome: 119, firefox: 121, safari: 17.4, node: 22 },
    present: () => typeof Promise.withResolvers === "function",
  },
  {
    api: "Promise.try",
    calls: /\bPromise\.try\(/,
    support: { chrome: 128, firefox: 134, safari: 18.2, node: 23 },
    present: () => typeof (Promise as any).try === "function",
  },
  {
    api: "Iterator.concat",
    calls: /\bIterator\.concat\(/,
    support: { chrome: 146, firefox: 147, safari: 26.4, node: 26 },
    present: () => typeof (globalThis as any).Iterator?.concat === "function",
  },
  {
    api: "Iterator.zip, Iterator.zipKeyed",
    calls: /\bIterator\.zip(Keyed)?\(/,
    support: { chrome: 153, firefox: 148, safari: false, node: false },
    present: () => typeof (globalThis as any).Iterator?.zip === "function",
  },
  {
    api: "Error.isError",
    calls: /\bError\.isError\(/,
    support: { chrome: 134, firefox: 138, safari: 18.4, node: 24.3 },
    present: () => typeof (Error as any).isError === "function",
  },
  {
    api: "RegExp.escape",
    calls: /\bRegExp\.escape\(/,
    support: { chrome: 136, firefox: 134, safari: 18.2, node: 24 },
    present: () => typeof (RegExp as any).escape === "function",
  },
  {
    api: "Uint8Array base64 and hex",
    calls: /\.(fromBase64|fromHex|toBase64|toHex|setFromBase64|setFromHex)\(/,
    support: { chrome: 140, firefox: 133, safari: 18.2, node: 25 },
    present: () => typeof (Uint8Array as any).fromBase64 === "function",
  },
  {
    api: "Math.sumPrecise",
    calls: /\bMath\.sumPrecise\(/,
    support: { chrome: 147, firefox: 137, safari: 26.2, node: false },
    present: () => typeof (Math as any).sumPrecise === "function",
  },
  {
    api: "Temporal",
    calls: /\bTemporal\./,
    support: { chrome: 144, firefox: 139, safari: false, node: 26 },
    present: () => typeof (globalThis as any).Temporal === "object",
  },
  {
    api: "DisposableStack, AsyncDisposableStack",
    calls: /\b(Async)?DisposableStack\b/,
    support: { chrome: 134, firefox: 141, safari: false, node: 24 },
    present: () => typeof (globalThis as any).DisposableStack === "function",
  },
];

function targets(): [Engine, number][] {
  return TARGET.map((target) => {
    const [, engine, version] = /^([a-z]+)([\d.]+)$/.exec(target)!;
    return [engine as Engine, Number(version)];
  });
}

function onEveryTarget(api: Api): boolean {
  return targets().every(([engine, version]) => {
    const added = api.support[engine];
    return added !== false && added <= version;
  });
}

const DIST_FILES = () =>
  readdirSync(join(BUILT, "dist")).filter(
    (name) => name.endsWith(".js") && !name.includes(".min.")
  );

describe("the dist and its targets", () => {
  test("the targets are Odoo's browsers and Node 26", () => {
    expect(TARGET).toEqual(["chrome154", "firefox157", "safari27", "node26"]);
  });

  test("each API's Node support is what this Node has", () => {
    const [, node] = targets().find(([engine]) => engine === "node")!;
    const running = Number(process.versions.node.split(".")[0]);
    expect(running).toBeGreaterThanOrEqual(node);
    for (const api of APIS) {
      const added = api.support.node;
      expect([api.api, api.present()]).toEqual([api.api, added !== false && added <= running]);
    }
  });

  test("the dist calls no API a target lacks, and of the newer ones only those owl adopted", () => {
    const calls: Record<string, string[]> = {};
    for (const file of DIST_FILES()) {
      const code = readFileSync(join(BUILT, "dist", file), "utf-8");
      calls[file] = APIS.filter((api) => api.calls.test(code)).map((api) => api.api);
    }
    const lacking = APIS.filter((api) => !onEveryTarget(api)).map((api) => api.api);
    for (const file in calls) {
      expect([file, calls[file].filter((api) => lacking.includes(api))]).toEqual([file, []]);
    }
    expect(lacking).toEqual([
      "Iterator.zip, Iterator.zipKeyed",
      "Math.sumPrecise",
      "Temporal",
      "DisposableStack, AsyncDisposableStack",
    ]);
    const adopted = ["Map/WeakMap getOrInsert, getOrInsertComputed", "Promise.withResolvers"];
    expect(calls["owl.es.js"]).toEqual(adopted);
    expect(calls["owl.runtime.es.js"]).toEqual(adopted);
    expect(calls["owl.compiler.es.js"]).toEqual([]);
  });

  test("owl's sources need no lowering for the targets", async () => {
    const options = (target: string | string[]) => ({
      entryPoints: ["src/index.ts", "src/compiler.ts"],
      outdir: "out",
      absWorkingDir: PACKAGE,
      bundle: true,
      format: "esm" as const,
      write: false,
      logLevel: "silent" as const,
      define: { __BUILD_DATE__: '""', __BUILD_HASH__: '""' },
      alias: PACKAGE_SOURCES,
      target,
    });
    const [forTargets, asIs] = await Promise.all([
      build(options(TARGET)),
      build(options("esnext")),
    ]);
    const texts = (result: typeof asIs) => result.outputFiles!.map((file) => file.text);
    expect(texts(forTargets)).toEqual(texts(asIs));
  });

  test("esbuild lowers nothing in the dist for the targets", async () => {
    for (const file of DIST_FILES()) {
      const code = readFileSync(join(BUILT, "dist", file), "utf-8");
      const forTargets = await transform(code, { target: TARGET, logLevel: "silent" });
      const asIs = await transform(code, { target: "esnext", logLevel: "silent" });
      expect([file, forTargets.code === asIs.code]).toEqual([file, true]);
    }
  });
});
