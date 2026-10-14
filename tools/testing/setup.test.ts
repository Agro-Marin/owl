import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test.each(["consumed console", "unexpected console", "assertion failure"] as const)(
  "the shared harness keeps its console and debug contract for %s",
  async (scenario) => {
    const root = resolve(__dirname, "../..");
    const scratch = await mkdtemp(resolve(tmpdir(), "owl-harness-"));
    try {
      await writeFile(
        resolve(scratch, "vitest.config.mjs"),
        `export default {
          root: ${JSON.stringify(scratch)},
          server: {fs: {allow: [${JSON.stringify(root)}, ${JSON.stringify(scratch)}]}},
          test: {reporters: ["default"], include: ["fixture.test.ts"], globals: true, setupFiles: [${JSON.stringify(resolve(root, "tools/testing/setup.ts"))}]}
        };`
      );
      await writeFile(
        resolve(scratch, "fixture.test.ts"),
        `import { debugLog } from ${JSON.stringify(resolve(root, "packages/owl-core/src/debug.ts"))};
        import { getConsoleOutput } from ${JSON.stringify(resolve(root, "tools/testing/console.ts"))};
        test("harness fixture", () => {
          for (let i = 0; i < 150; i++) debugLog("effect", "fixture-" + i);
          console.warn("fixture warning");
          ${scenario === "consumed console" ? 'expect(getConsoleOutput()).toEqual(["warn:fixture warning"]);' : scenario === "assertion failure" ? "getConsoleOutput(); expect(1).toBe(2);" : ""}
        });`
      );
      const run = spawnSync(
        process.execPath,
        [
          resolve(root, "node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          resolve(scratch, "vitest.config.mjs"),
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, OWL_DEBUG: "effect" },
        }
      );
      const output = run.stdout + run.stderr;
      console.debug("[owl:harness-probe]", scenario, run.status, output);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(scenario === "consumed console" ? 0 : 1);
      expect(output).toContain("[owl:test-debug] collected 150 trace(s)");
      if (scenario === "consumed console") {
        expect(output).not.toContain("last 100 trace(s)");
      } else {
        expect(output).toContain("last 100 trace(s)");
        expect(output).toContain("[owl:effect] fixture-149");
        expect(output).not.toContain("[owl:effect] fixture-0'");
        expect(output).toContain(
          scenario === "unexpected console" ? "Unexpected console output" : "expected 1 to be 2"
        );
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
);
