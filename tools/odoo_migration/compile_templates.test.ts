import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildHash } from "../../packages/owl/build_hash.mjs";
import { scratchDir } from "../workspace.mjs";

const root = resolve(__dirname, "../..");
let OWL: string;
let BUILD: string;

beforeAll(() => {
  OWL = scratchDir("owl-checker-build");
  BUILD = join(OWL, "packages/owl/dist/owl.es.js");
  execFileSync(process.execPath, ["build.mjs", "--outdir", join(OWL, "packages/owl/dist")], {
    cwd: join(root, "packages/owl"),
    stdio: "pipe",
  });
}, 60000);

afterAll(() => rm(OWL, { recursive: true, force: true }));

test("the Odoo template checker releases every temporary app, including failures", async () => {
  const scratch = scratchDir("owl-template-check");
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
      const { App } = await import(${JSON.stringify(BUILD)});
      console.debug("[owl:integration] temporary apps retained:", App.apps.size);
      if (App.apps.size !== 0) throw new Error("temporary apps retained");
    `
    );
    const run = spawnSync(process.execPath, [probe, scratch], {
      encoding: "utf8",
      env: { ...process.env, OWL, OWL_DEBUG: "template,lifecycle,scope" },
    });
    expect(run.stdout).toContain("compiled 3 templates, 1 failures");
    expect(run.stdout).toContain("[owl:integration] temporary apps retained: 0");
    expect(run.stdout.match(/\[owl:lifecycle\] destroy app/g)).toHaveLength(3);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe("");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "the raw checker reports its status for valid or malformed XML (malformed=%s)",
  async (malformed) => {
    const scratch = scratchDir("owl-raw-status");
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
          env: { ...process.env, OWL, OWL_DEBUG: "template,lifecycle,scope" },
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
    const scratch = scratchDir("owl-inherited-check");
    try {
      const templates = join(scratch, "input/static/src");
      const web = join(scratch, "odoo/addons/web");
      const xpath = join(scratch, "odoo/node_modules/xpath");
      await mkdir(templates, { recursive: true });
      await mkdir(join(web, "static/src/core"), { recursive: true });
      await mkdir(xpath, { recursive: true });
      await writeFile(join(scratch, "package.json"), '{"type":"module"}');
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
      if (scenario === "regression") {
        await mkdir(join(scratch, "views_only/views"), { recursive: true });
        await writeFile(
          join(scratch, "views_only/views/views.xml"),
          `<odoo>
            <record id="kanban" model="ir.ui.view"><field name="arch" type="xml">
              <kanban><templates><t t-name="card"><p/></t><t t-name="arch_rejection"><p t-unknown="1"/></t></templates></kanban>
            </field></record>
            <record id="kanban_extension" model="ir.ui.view"><field name="arch" type="xml">
              <xpath expr="//t[@t-name='card']" position="attributes"><attribute name="t-att-style">1</attribute></xpath>
              <xpath expr="//t[@t-name='card']/p" position="attributes"><attribute name="t-att-style">1</attribute></xpath>
            </field></record>
          </odoo>`
        );
      }
      const bundle = JSON.stringify(BUILD);
      const oldBuild = join(scratch, "old.mjs");
      await writeFile(
        oldBuild,
        `
      import { App as BaseApp } from ${bundle};
      export { setDebug } from ${bundle};
      export class App extends BaseApp {
        getTemplate(name) {
          if (name === "new_rejection" || name === "arch_rejection") return () => {};
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
      const roots = [join(scratch, "input")];
      if (scenario === "regression") {
        await mkdir(join(scratch, "python_only"), { recursive: true });
        await writeFile(join(scratch, "python_only/__init__.py"), "");
        roots.push(join(scratch, "views_only"), join(scratch, "python_only"));
      }
      const run = spawnSync(process.execPath, [probe, ...roots], {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          OWL,
          OLD: oldBuild,
          WEB: web,
          OWL_DEBUG: "template,lifecycle,scope",
        },
      });
      console.debug("[owl:inherited-checker]", scenario, run.status, run.stdout, run.stderr);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe(
        scenario === "regression"
          ? `skipped ${join(scratch, "python_only")}: no template file (**/static/src/**/*.xml) and no view file\n`
          : ""
      );
      expect(run.stdout).toContain("[owl:inherited-probe] temporary apps retained: 0");
      expect(run.stdout.match(/\[owl:lifecycle\] destroy app/g)).toHaveLength(
        scenario === "regression" ? 8 : 2
      );
      if (scenario === "regression") {
        expect(run.stdout).toContain("REGRESSION new_rejection");
        expect(run.stdout).toContain("1 rejected only by the new build");
        expect(run.stdout).toMatch(/^REGRESSION \S+\/views\/views.xml arch_rejection :: /m);
        expect(run.stdout).toMatch(
          /^REGRESSION \S+\/views\/views.xml kanban_extension :: sets t-att-style on a <t>/m
        );
        expect(run.stdout).toContain(
          "view archs: 2 templates, 2 rejected only by the new build (0 by both), 1 inherited attribute sets on a <t>"
        );
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

async function runRaw(source: string, env: Record<string, string>) {
  const scratch = scratchDir("owl-raw-check");
  try {
    await mkdir(join(scratch, "static/src"), { recursive: true });
    await writeFile(join(scratch, "static/src/templates.xml"), source);
    return spawnSync(
      process.execPath,
      [join(root, "tools/odoo_migration/compile_templates.mjs"), scratch],
      { encoding: "utf8", timeout: 10000, env: { ...process.env, ...env } }
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("the raw checker counts an unknown custom directive as a failure, a missing template not", async () => {
  const run = await runRaw(
    `<templates>
      <t t-name="unknown"><p t-custom-nope="1"/></t>
      <t t-name="calls"><t t-call="elsewhere"/></t>
    </templates>`,
    { OWL }
  );
  console.debug("[owl:raw-checker-directive]", run.status, run.stdout, run.stderr);
  expect(run.stdout).toMatch(/^FAIL .* unknown :: Custom directive "nope" is not defined$/m);
  expect(run.stdout).toContain("compiled 2 templates, 1 failures");
  expect(run.status).toBe(1);
});

test("the raw checker names the build it needs when OWL has none", async () => {
  const empty = scratchDir("owl-no-build");
  try {
    const run = await runRaw('<templates><t t-name="good"><p/></t></templates>', { OWL: empty });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`no Owl build in ${empty}`);
    expect(run.stderr).toContain("run `npm run build` there");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test.each(["compile_templates", "compile_inherited_templates"])(
  "the %s checker refuses a root that does not exist or holds no template",
  async (checker) => {
    const scratch = scratchDir("owl-checker-roots");
    try {
      const web = join(scratch, "odoo/addons/web");
      await mkdir(join(web, "static/src/core"), { recursive: true });
      await writeFile(join(web, "static/src/core/template_inheritance.js"), "export {};");
      await mkdir(join(scratch, "odoo/node_modules/xpath"), { recursive: true });
      await writeFile(join(scratch, "odoo/node_modules/xpath/index.js"), "");
      await mkdir(join(scratch, "empty/static/lib"), { recursive: true });
      await writeFile(join(scratch, "empty/static/lib/t.xml"), "<templates/>");
      const run = (dir: string) =>
        spawnSync(process.execPath, [join(root, `tools/odoo_migration/${checker}.mjs`), dir], {
          encoding: "utf8",
          timeout: 10000,
          env: { ...process.env, OWL, WEB: web, OLD: BUILD },
        });
      const missing = run(join(scratch, "adons"));
      const empty = run(join(scratch, "empty"));
      console.debug("[owl:checker-roots]", checker, missing.stderr, empty.stderr);
      expect([missing.status, empty.status]).toEqual([2, 2]);
      expect(missing.stderr).toContain(`${join(scratch, "adons")} does not exist`);
      expect(empty.stderr).toContain(`skipped ${join(scratch, "empty")}: no template file`);
      expect(empty.stderr).toContain("nothing to check: every root holds no template file");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
);

test("the raw checker refuses a build older than the sources beside it", async () => {
  const owl = scratchDir("owl-stale-build");
  try {
    await mkdir(join(owl, "packages/owl-core/src"), { recursive: true });
    await mkdir(join(owl, "packages/owl/dist"), { recursive: true });
    await writeFile(join(owl, "packages/owl-core/src/a.ts"), "export const a = 1;");
    const bundle = await readFile(BUILD, "utf8");
    const stale = join(owl, "packages/owl/dist/owl.es.js");
    await writeFile(stale, bundle);
    const sources = buildHash(owl);
    const refused = await runRaw('<templates><t t-name="good"><p/></t></templates>', { OWL: owl });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(
      new RegExp(`is build [0-9a-f]{8}\\S*, the sources beside it are ${sources}: run`)
    );
    await writeFile(
      stale,
      bundle.replace(/^var buildHash = "[^"]*";$/m, `var buildHash = "${sources}";`)
    );
    const fresh = await runRaw('<templates><t t-name="good"><p/></t></templates>', { OWL: owl });
    expect(fresh.stdout).toContain("compiled 1 templates, 0 failures");
    expect(fresh.status).toBe(0);
  } finally {
    await rm(owl, { recursive: true, force: true });
  }
});

test("the inherited checker names WEB when it is not Odoo's web addon, and OLD when it is missing", async () => {
  const scratch = scratchDir("owl-inherited-env");
  try {
    const web = join(scratch, "odoo/addons/web");
    await mkdir(join(scratch, "input/static/src"), { recursive: true });
    await writeFile(join(scratch, "input/static/src/t.xml"), "<templates/>");
    const run = (env: Record<string, string>) =>
      spawnSync(
        process.execPath,
        [
          join(root, "tools/odoo_migration/compile_inherited_templates.mjs"),
          join(scratch, "input"),
        ],
        { encoding: "utf8", timeout: 10000, env: { ...process.env, OWL, ...env } }
      );
    const noWeb = run({ WEB: web });
    expect(noWeb.status).toBe(2);
    expect(noWeb.stderr).toContain(`${web} is not Odoo's web addon`);
    await mkdir(join(web, "static/src/core"), { recursive: true });
    await writeFile(join(web, "static/src/core/template_inheritance.js"), "export {};");
    await mkdir(join(scratch, "odoo/node_modules/xpath"), { recursive: true });
    await writeFile(join(scratch, "odoo/node_modules/xpath/index.js"), "");
    const noOld = run({ WEB: web });
    expect(noOld.status).toBe(2);
    expect(noOld.stderr).toContain(`${join(web, "static/lib/owl/owl.es.js")} not found: set OLD`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
