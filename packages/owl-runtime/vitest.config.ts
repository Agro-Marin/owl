import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

const NODE_TESTS = ["tests/no_dom.test.ts"];
const test = {
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
  resolve: {
    alias: {
      "@odoo/owl-core": fileURLToPath(
        new URL("../owl-core/src/index.ts", import.meta.url)
      ),
      "@odoo/owl-compiler/src/parser": fileURLToPath(
        new URL("../owl-compiler/src/parser.ts", import.meta.url)
      ),
      "@odoo/owl-compiler/src/inline_expressions": fileURLToPath(
        new URL("../owl-compiler/src/inline_expressions.ts", import.meta.url)
      ),
      "@odoo/owl-compiler": fileURLToPath(
        new URL("../owl-compiler/src/index.ts", import.meta.url)
      ),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...test,
          name: "dom",
          environment: "jsdom",
          include: ["tests/**/*.test.ts"],
          exclude: NODE_TESTS,
        },
      },
      {
        extends: true,
        test: { ...test, name: "node", environment: "node", include: NODE_TESTS },
      },
    ],
  },
});
