// @vitest-environment node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("declarations build with this Node even inside npm exec", () => {
  const cwd = resolve(__dirname, "..");
  const run = spawnSync(process.execPath, ["build.mjs", "types"], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, npm_config_call: "node --version", NODE_DEBUG: "owl-build" },
  });
  if (run.status !== 0) {
    console.debug("[owl:types-build-test]", run.stdout, run.stderr);
  }
  expect(run.status).toBe(0);
  expect(run.stderr).toMatch(/OWL-BUILD \d+: types owl using/);
  expect(run.stderr).toMatch(/OWL-BUILD \d+: types compiler using/);
  expect(run.stdout + run.stderr).not.toContain("type nodes were renamed");
  expect(readFileSync(resolve(cwd, "dist/types/owl.d.ts"), "utf8")).toContain("signal");
  expect(readFileSync(resolve(cwd, "dist/types/compiler.d.ts"), "utf8")).toContain("compile");
}, 60000);

test("a consumer outside the checkout gets complete collection and hook types", () => {
  const packageRoot = resolve(__dirname, "..");
  const consumerRoot = mkdtempSync(resolve(tmpdir(), "owl-type-consumer-"));
  try {
    const installed = resolve(consumerRoot, "node_modules/@odoo/owl");
    mkdirSync(resolve(installed, "dist/types"), { recursive: true });
    copyFileSync(resolve(packageRoot, "package.json"), resolve(installed, "package.json"));
    for (const entry of ["owl", "compiler"]) {
      copyFileSync(
        resolve(packageRoot, `dist/types/${entry}.d.ts`),
        resolve(installed, `dist/types/${entry}.d.ts`)
      );
    }
    writeFileSync(
      resolve(consumerRoot, "consumer.ts"),
      `
      import { App, signal, Registry, Resource, useApp, useConfig, config, providePlugins, t } from "@odoo/owl";
      import { signal as runtimeSignal, useApp as runtimeApp, useConfig as runtimeConfig } from "@odoo/owl/runtime";
      import { compile } from "@odoo/owl/compiler";
      const map = signal.Map(new Map<string, number>())();
      map.set("a", 1).get("a");
      map.has("a");
      map.size;
      map.getOrInsert("a", 2);
      map.getOrInsertComputed("b", () => 3);
      const entries: [string, number][] = map.entries().toArray();
      map.delete("a"); map.clear();
      const weak = signal.Object(new WeakMap<object, number>())();
      const key = {};
      weak.set(key, 1).get(key);
      weak.has(key); weak.delete(key);
      weak.getOrInsert(key, 2); weak.getOrInsertComputed(key, () => 3);
      const other = runtimeSignal.Map(new Map<string, number>())();
      other.set("x", 1); other.values().toArray();
      new Registry<number>().add("a", 1).get("a");
      new Resource<string>().add("a").items();
      class CustomApp extends App {
        lookup(id: string): number { return id.length; }
      }
      const app = useApp();
      const defaultRuntimeApp: App = runtimeApp();
      const custom: CustomApp = useApp<CustomApp>();
      const customRuntime: CustomApp = runtimeApp<CustomApp>();
      custom.lookup("id"); customRuntime.lookup("id");
      // @ts-expect-error the published default must remain App, not any
      app.lookup("id");
      // @ts-expect-error custom runtime hosts must extend App
      useApp<{ dev: boolean }>();
      // @ts-expect-error the runtime entry has the same App constraint
      runtimeApp<{ dev: boolean }>();
      const unchecked = useConfig("value");
      // @ts-expect-error unchecked configuration is unknown
      unchecked.toFixed();
      // @ts-expect-error deprecated aliases preserve the checked type surface
      config("value").toFixed();
      // @ts-expect-error the runtime entry preserves unknown config reads
      runtimeConfig("value").toFixed();
      // @ts-expect-error the manager exposes unknown dynamic values
      app.pluginManager.config.value.toFixed();
      const explicit: number = useConfig<number>("value");
      const required: number = useConfig("value", t.number());
      const optional: number | undefined = useConfig("value", t.number().optional());
      const defaulted: number = useConfig("value", t.number().optional(1));
      interface NamedConfig { count: number; lookup(id: string): number; }
      const named: NamedConfig = { count: 1, lookup: (id) => id.length };
      new App({ config: named });
      providePlugins([], named);
      compile("<p/>");
      void [entries, defaultRuntimeApp, explicit, required, optional, defaulted];
    `
    );
    writeFileSync(
      resolve(consumerRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2024",
          module: "ESNext",
          moduleResolution: "bundler",
          types: [],
          lib: ["ES2024", "ESNext.Iterator", "DOM", "DOM.Iterable"],
        },
        files: ["consumer.ts"],
      })
    );
    const run = spawnSync(
      process.execPath,
      [resolve(packageRoot, "../../node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
      {
        cwd: consumerRoot,
        encoding: "utf8",
        timeout: 30000,
      }
    );
    console.debug("[owl:consumer-types]", run.status, run.stdout, run.stderr);
    expect(run.status).toBe(0);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});
