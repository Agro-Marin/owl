import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

const sources = {
  "@odoo/owl-core": fileURLToPath(new URL("../owl-core/src/index.ts", import.meta.url)),
  "@odoo/owl-compiler": fileURLToPath(new URL("../owl-compiler/src/index.ts", import.meta.url)),
  "@odoo/owl-runtime": fileURLToPath(new URL("../owl-runtime/src/index.ts", import.meta.url)),
};
const RUNTIME_TESTS = ["tests/compiler_module.test.ts", "tests/runtime.test.ts"];
const NODE_TESTS = ["tests/dist.test.ts", "tests/types_build.test.ts"];
const fullAliases = [
  ...Object.entries(sources).map(([find, replacement]) => ({ find, replacement })),
  {
    find: /^\.\/bundled_compiler$/,
    replacement: fileURLToPath(new URL("src/bundled_compiler.ts", import.meta.url)),
  },
];

const test = {
  environment: "jsdom",
  root: ".",
  setupFiles: ["./tests/setup.ts"],
  globals: true,
  testTimeout: 10000,
};

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify("dev"),
    __BUILD_HASH__: JSON.stringify("dev"),
  },
  test: {
    projects: [
      {
        extends: true,
        resolve: { alias: fullAliases },
        test: {
          ...test,
          name: "full",
          include: ["tests/**/*.test.ts"],
          exclude: [...RUNTIME_TESTS, ...NODE_TESTS],
        },
      },
      {
        extends: true,
        resolve: { alias: sources },
        test: { ...test, name: "runtime", include: RUNTIME_TESTS },
      },
      {
        extends: true,
        resolve: { alias: fullAliases },
        test: { ...test, name: "node", environment: "node", include: NODE_TESTS },
      },
    ],
  },
});
