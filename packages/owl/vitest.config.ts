import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import { PACKAGE_SOURCES, TEST_DEFAULTS } from "../../tools/testing/workspace.mjs";

const RUNTIME_TESTS = ["tests/compiler_module.test.ts", "tests/runtime.test.ts"];
const NODE_TESTS = ["tests/dist.test.ts", "tests/types_build.test.ts"];
const fullAliases = [
  ...Object.entries(PACKAGE_SOURCES).map(([find, replacement]) => ({ find, replacement })),
  {
    find: /^\.\/bundled_compiler$/,
    replacement: fileURLToPath(new URL("src/bundled_compiler.ts", import.meta.url)),
  },
];

const test = { ...TEST_DEFAULTS, environment: "jsdom", setupFiles: ["./tests/setup.ts"] };

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify("dev"),
    __BUILD_HASH__: JSON.stringify("dev"),
  },
  test: {
    globalSetup: TEST_DEFAULTS.globalSetup,
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
        resolve: { alias: PACKAGE_SOURCES },
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
