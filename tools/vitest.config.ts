import { defineConfig } from "vitest/config";
import { ROOT, TEST_DEFAULTS } from "./testing/workspace.mjs";

export default defineConfig({
  test: {
    ...TEST_DEFAULTS,
    root: ROOT,
    include: ["tools/**/*.test.ts"],
  },
});
