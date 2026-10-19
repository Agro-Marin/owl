import { defineConfig } from "vitest/config";
import { PACKAGE_SOURCES, TEST_DEFAULTS } from "../../tools/workspace.mjs";

export default defineConfig({
  resolve: {
    alias: { "@odoo/owl-core": PACKAGE_SOURCES["@odoo/owl-core"] },
  },
  test: {
    ...TEST_DEFAULTS,
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
