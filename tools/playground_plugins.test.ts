import { build } from "esbuild";
import { resolve } from "node:path";
import { ROOT } from "./workspace.mjs";
import { vi } from "vitest";

test.each(["ProjectPlugin", "TemplatePlugin"])(
  "tutorial plugins start in either dependency order (%s first)",
  async (first) => {
    const built = await build({
      stdin: {
        contents:
          'export * from "./tools/playground/src/plugins.js"; export {PluginManager} from "@odoo/owl";',
        resolveDir: ROOT,
      },
      alias: { "@odoo/owl": resolve(ROOT, "packages/owl-core/src/index.ts") },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      write: false,
    });
    const api = await import(
      `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`
    );
    const manager = new api.PluginManager({});
    try {
      manager.startPlugins([api[first]]);
      await manager.ready;
      const templates = manager.getPlugin(api.TemplatePlugin);
      const project = manager.getPlugin(api.ProjectPlugin);
      expect(project.templates).toBe(templates);
      expect(templates.project).toBe(project);
      vi.stubGlobal("fetch", async () => new Response("# Tutorial"));
      await templates.openTutorial({
        id: "review",
        name: "Review",
        steps: [{ title: "First", files: { "readme.md": `review-${first}.md` } }],
      });
      expect(project.activeProject().tutorialId).toBe("review");
      expect(templates.code.primaryFile()).toBe("readme.md");
    } finally {
      vi.unstubAllGlobals();
      manager.destroy();
    }
  }
);
