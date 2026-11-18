import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scratchDir } from "../workspace.mjs";

const root = resolve(__dirname, "../..");
const script = join(root, "tools/odoo_migration/compare_codegen.mjs");

async function fixture() {
  const scratch = scratchDir("owl-compare-codegen");
  await mkdir(join(scratch, "mod/static/src"), { recursive: true });
  await writeFile(
    join(scratch, "mod/static/src/templates.xml"),
    `<templates><t t-name="a"><p>a</p></t><t t-name="b"><p>b</p></t></templates>`
  );
  await writeFile(
    join(scratch, "mod/static/src/component.js"),
    "export const T = xml`<span>inline</span>`;\n"
  );
  const compiler = (body: string) => `export function compile(source, { name }) { ${body} }\n`;
  await writeFile(
    join(scratch, "same.mjs"),
    compiler("return { toString: () => `code of ${name}: ${source}` };")
  );
  await writeFile(
    join(scratch, "differs.mjs"),
    compiler('return { toString: () => name === "b" ? "changed" : `code of ${name}: ${source}` };')
  );
  await writeFile(
    join(scratch, "rejects.mjs"),
    compiler(
      'if (source.includes("inline")) throw new Error("refused"); return { toString: () => `code of ${name}: ${source}` };'
    )
  );
  return scratch;
}

function run(scratch: string, oldName: string, newName: string) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--old",
      join(scratch, oldName),
      "--new",
      join(scratch, newName),
      join(scratch, "mod"),
    ],
    { encoding: "utf8" }
  );
}

test("the codegen differential passes when both compilers agree on every template", async () => {
  const scratch = await fixture();
  try {
    const result = run(scratch, "same.mjs", "same.mjs");
    expect(result.stdout).toContain("2 static and 1 inline templates: 3 identical, 0 differ");
    expect(result.status).toBe(0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the codegen differential names a template whose code differs and fails", async () => {
  const scratch = await fixture();
  try {
    const result = run(scratch, "same.mjs", "differs.mjs");
    expect(result.stdout).toMatch(/DIFFERS .*templates\.xml b, line 1:/);
    expect(result.stdout).toContain('new "changed"');
    expect(result.stdout).toContain("2 identical, 1 differ");
    expect(result.status).toBe(1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the codegen differential fails on a template only the new compiler rejects", async () => {
  const scratch = await fixture();
  try {
    const result = run(scratch, "same.mjs", "rejects.mjs");
    expect(result.stdout).toMatch(/NEW-ONLY FAILURE .*component\.js xml#1: refused/);
    expect(result.stdout).toContain("1 rejected only by the new compiler");
    expect(result.status).toBe(1);
    const reverse = run(scratch, "rejects.mjs", "same.mjs");
    expect(reverse.stdout).toContain("1 only by the old");
    expect(reverse.status).toBe(0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
