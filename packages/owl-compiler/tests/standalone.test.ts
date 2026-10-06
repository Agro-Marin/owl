// @vitest-environment node
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { compileTemplates } from "../src/standalone";
import { getConsoleOutput } from "./helpers";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "owl-standalone-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true });
});

describe("standalone compiler", () => {
  test("any template name gives a valid module", async () => {
    await writeFile(
      path.join(dir, "a.xml"),
      `<templates><t t-name="2col">a</t><t t-name='say"hi'>b</t><t t-name="class">c</t></templates>`
    );
    const code = await compileTemplates([dir]);
    expect(getConsoleOutput()).toEqual(["log:3 templates compiled"]);
    const templates = new Function(code.replace("export const templates =", "return"))();
    expect(Object.keys(templates)).toEqual(["2col", 'say"hi', "class"]);
  });

  test("an invalid xml file is reported", async () => {
    await writeFile(path.join(dir, "bad.xml"), `<templates><t t-name="x"><div></t></templates>`);
    await compileTemplates([dir]);
    const output = getConsoleOutput();
    expect(output[0]).toBe(`warn:Error while parsing ${path.join(dir, "bad.xml")}`);
    expect(output[1]).toMatch(/^error:.*Invalid XML in template/);
    expect(output[2]).toBe("log:0 templates compiled");
  });

  test("a precompiled template is named and reads the app's global values", async () => {
    await writeFile(
      path.join(dir, "g.xml"),
      `<templates><t t-name="web.g"><t t-out="__globals__.x"/></t></templates>`
    );
    const code = await compileTemplates([dir]);
    expect(getConsoleOutput()).toEqual(["log:1 templates compiled"]);
    const templates = new Function(code.replace("export const templates =", "return"))();
    const source = String(templates["web.g"]);
    // the runtime always passes __globals__ among its helpers
    expect(source).toContain("let { __globals__, safeOutput } = helpers;");
    expect(source).toContain(`// Template name: "web.g"`);
  });
});
