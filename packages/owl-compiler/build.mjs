import * as esbuild from "esbuild";
import { TARGET } from "../owl/build_target.mjs";

// dist/compile_templates.mjs: the node precompiler (tools/compile_owl_templates.mjs).
// The compiler itself is bundled into @odoo/owl from its sources.
await esbuild.build({
  entryPoints: ["src/standalone/index.ts"],
  outfile: "dist/compile_templates.mjs",
  bundle: true,
  format: "esm",
  target: TARGET,
  platform: "node",
  external: ["fs", "fs/promises", "path", "jsdom"],
  alias: { "@odoo/owl-core": "../owl-core/src/index.ts" },
});
