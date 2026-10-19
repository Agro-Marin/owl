import { defineConfig } from "vitest/config";
import { PACKAGE_SOURCES, TEST_DEFAULTS } from "../../tools/testing/workspace.mjs";

const NODE_TESTS = ["tests/no_dom.test.ts"];
const test = { ...TEST_DEFAULTS, setupFiles: ["./tests/setup.ts"] };

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify("dev"),
    __BUILD_HASH__: JSON.stringify("dev"),
  },
  resolve: {
    alias: {
      "@odoo/owl-core": PACKAGE_SOURCES["@odoo/owl-core"],
      "@odoo/owl-compiler": PACKAGE_SOURCES["@odoo/owl-compiler"],
    },
  },
  test: {
    globalSetup: TEST_DEFAULTS.globalSetup,
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
