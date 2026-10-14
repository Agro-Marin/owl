import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const COMPILER_CORE = new URL("../packages/owl/src/compiler_core.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@odoo/owl-core") {
      return { url: COMPILER_CORE, format: "module-typescript", shortCircuit: true };
    }
    if (/^\.\.?(\/|$)/.test(specifier) && context.parentURL?.endsWith(".ts")) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
        if (existsSync(candidate)) {
          return {
            url: pathToFileURL(candidate).href,
            format: "module-typescript",
            shortCircuit: true,
          };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
