import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the Odoo template checker releases every temporary app, including failures", async () => {
  const root = resolve(__dirname, "../..");
  const scratch = await mkdtemp(join(tmpdir(), "owl-template-check-"));
  try {
    const templates = join(scratch, "static/src");
    await mkdir(templates, { recursive: true });
    await writeFile(
      join(templates, "templates.xml"),
      `<templates>
      <t t-name="good"><p>hello</p></t>
      <t t-name="bad"><p t-unknown="true"/></t>
      <t t-name="also-good"><span>bye</span></t>
    </templates>`
    );
    const probe = join(scratch, "probe.mjs");
    await writeFile(
      probe,
      `
      await import(${JSON.stringify(join(root, "tools/odoo_migration/compile_templates.mjs"))});
      const { App } = await import(${JSON.stringify(join(root, "packages/owl/dist/owl.es.js"))});
      console.debug("[owl:integration] temporary apps retained:", App.apps.size);
      if (App.apps.size !== 0) throw new Error("temporary apps retained");
    `
    );
    const run = spawnSync(process.execPath, [probe, scratch], {
      encoding: "utf8",
      env: { ...process.env, OWL: root, OWL_DEBUG: "template,lifecycle,scope" },
    });
    expect(run.stdout).toContain("compiled 3 templates, 1 failures");
    expect(run.stdout).toContain("[owl:integration] temporary apps retained: 0");
    expect(run.stdout.match(/\[owl:lifecycle\] destroy app/g)).toHaveLength(3);
    // The checker exits with failure when its compilation findings include a
    // failure. The probe itself completes without throwing about retained apps.
    expect(run.status).toBe(1);
    expect(run.stderr).toBe("");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "the raw checker reports its status for valid or malformed XML (malformed=%s)",
  async (malformed) => {
    const root = resolve(__dirname, "../..");
    const scratch = await mkdtemp(join(tmpdir(), "owl-raw-status-"));
    try {
      const templates = join(scratch, "static/src");
      await mkdir(templates, { recursive: true });
      await writeFile(
        join(templates, "templates.xml"),
        malformed ? "<templates><t>" : '<templates><t t-name="good"><p/></t></templates>'
      );
      const run = spawnSync(
        process.execPath,
        [join(root, "tools/odoo_migration/compile_templates.mjs"), scratch],
        {
          encoding: "utf8",
          timeout: 10000,
          env: { ...process.env, OWL: root, OWL_DEBUG: "template,lifecycle,scope" },
        }
      );
      console.debug("[owl:raw-checker-status]", run.status, run.stdout, run.stderr);
      expect(run.status).toBe(malformed ? 1 : 0);
      expect(run.stdout).toContain(malformed ? "XMLPARSE" : "compiled 1 templates, 0 failures");
      expect(run.stderr).toBe("");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
);

test.each(["regression", "coverage"] as const)(
  "the inherited checker exposes %s and releases both builds' apps",
  async (scenario) => {
    const root = resolve(__dirname, "../..");
    const scratch = await mkdtemp(join(tmpdir(), "owl-inherited-check-"));
    try {
      const templates = join(scratch, "input/static/src");
      const web = join(scratch, "odoo/addons/web");
      const xpath = join(scratch, "odoo/node_modules/xpath");
      await mkdir(templates, { recursive: true });
      await mkdir(join(web, "static/src/core"), { recursive: true });
      await mkdir(xpath, { recursive: true });
      await writeFile(join(scratch, "package.json"), '{"type":"module"}');
      // These tests exercise checker status, coverage and lifetime, rather than
      // Odoo's inheritance engine. No XPath is evaluated by these fixtures.
      await writeFile(join(xpath, "package.json"), '{"main":"index.cjs"}');
      await writeFile(
        join(xpath, "index.cjs"),
        'exports.parse = () => { throw new Error("unexpected XPath evaluation"); };'
      );
      await writeFile(
        join(web, "static/src/core/template_inheritance.js"),
        'export function applyInheritance() { throw new Error("unexpected inheritance application"); }'
      );
      const source =
        scenario === "regression"
          ? '<templates><t t-name="good"><p/></t><t t-name="new_rejection"><p t-unknown="true"/></t></templates>'
          : '<templates><t t-name="good"><p/></t><t t-name="missing_primary" t-inherit="missing" t-inherit-mode="primary"/><t t-inherit="absent" t-inherit-mode="extension"/></templates>';
      await writeFile(join(templates, "templates.xml"), source);
      if (scenario === "coverage") await writeFile(join(templates, "broken.xml"), "<templates><t>");
      const bundle = JSON.stringify(join(root, "packages/owl/dist/owl.es.js"));
      const oldBuild = join(scratch, "old.mjs");
      await writeFile(
        oldBuild,
        `
      import { App as BaseApp } from ${bundle};
      export { setDebug } from ${bundle};
      export class App extends BaseApp {
        getTemplate(name) {
          if (name === "new_rejection") return () => {};
          return super.getTemplate(name);
        }
      }
    `
      );
      const probe = join(scratch, "probe.mjs");
      await writeFile(
        probe,
        `
      await import(${JSON.stringify(join(root, "tools/odoo_migration/compile_inherited_templates.mjs"))});
      const { App } = await import(${bundle});
      console.debug("[owl:inherited-probe] temporary apps retained:", App.apps.size);
      if (App.apps.size) throw new Error("temporary apps retained");
    `
      );
      const run = spawnSync(process.execPath, [probe, join(scratch, "input")], {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          OWL: root,
          OLD: oldBuild,
          WEB: web,
          OWL_DEBUG: "template,lifecycle,scope",
        },
      });
      console.debug("[owl:inherited-checker]", scenario, run.status, run.stdout, run.stderr);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe("");
      expect(run.stdout).toContain("[owl:inherited-probe] temporary apps retained: 0");
      expect(run.stdout.match(/\[owl:lifecycle\] destroy app/g)).toHaveLength(
        scenario === "regression" ? 4 : 2
      );
      if (scenario === "regression") {
        expect(run.stdout).toContain("REGRESSION new_rejection");
        expect(run.stdout).toContain("1 rejected only by the new build");
      } else {
        expect(run.stdout).toContain("0 rejected only by the new build");
        expect(run.stdout).toContain(
          "coverage: 1 XML parse failures, 1 unresolved primary templates, 1 extension targets absent, 0 JSDOM-only comparisons skipped"
        );
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
);
