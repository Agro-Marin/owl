import { defineConfig } from "vitest/config";
import { TEST_DEFAULTS } from "../../tools/testing/workspace.mjs";

export default defineConfig({
  test: {
    ...TEST_DEFAULTS,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    onUnhandledError(error) {
      if (error.name === "IntentionalTestError") {
        return false;
      }
    },
  },
});
