import { spawnSync } from "child_process";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { compileTemplates } from "../src/standalone";
import { getConsoleOutput } from "./helpers";

let dir: string;
const root = path.join(__dirname, "..", "..", "..");

function runCompiler(args: string[]) {
  const run = spawnSync(
    process.execPath,
    [path.join(root, "tools", "compile_owl_templates.mjs"), ...args],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, NODE_DEBUG: "owl-compile" },
    }
  );
  console.debug("[owl:standalone-cli-test]", run.status, run.stdout, run.stderr);
  return run;
}

async function templateNamesInFile(file: string) {
  const code = await readFile(file, "utf8");
  return Object.keys(new Function(code.replace("export const templates =", "return"))());
}

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

  test("an invalid xml file rejects compilation with its file and cause", async () => {
    await writeFile(path.join(dir, "bad.xml"), `<templates><t t-name="x"><div></t></templates>`);
    await expect(compileTemplates([dir])).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        {
          message: `Error while parsing ${path.join(dir, "bad.xml")}`,
          cause: expect.objectContaining({
            message: expect.stringContaining("Invalid XML in template"),
          }),
        },
      ],
    });
    expect(getConsoleOutput()).toEqual([]);
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
    expect(source).toContain("let { __globals__, safeOutput } = helpers;");
    expect(source).toContain(`// Template name: "web.g"`);
  });

  test("object prototype names are ordinary own template entries", async () => {
    await writeFile(
      path.join(dir, "special.xml"),
      '<templates><t t-name="__proto__">a</t><t t-name="constructor">b</t><t t-name="toString">c</t></templates>'
    );
    const code = await compileTemplates([dir]);
    expect(getConsoleOutput()).toEqual(["log:3 templates compiled"]);
    const templates = new Function(code.replace("export const templates =", "return"))();
    expect(Object.keys(templates)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.getPrototypeOf(templates)).toBe(Object.prototype);
    expect(typeof templates.__proto__).toBe("function");
  });

  test("compilation aggregates every invalid template and rejects duplicate names", async () => {
    await writeFile(
      path.join(dir, "a.xml"),
      '<templates><t t-name="same"><p/></t><t t-name="bad"><p t-unknown="true"/></t></templates>'
    );
    await writeFile(
      path.join(dir, "b.xml"),
      '<templates><t t-name="same"><span/></t><t t-name="also_bad"><t t-if=""/></t></templates>'
    );
    const failure = await compileTemplates([dir]).catch((error) => error);
    expect(getConsoleOutput()).toEqual([]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(3);
    expect(failure.errors.map((error: Error) => error.message)).toEqual([
      `Error while compiling 'bad' (in file ${path.join(dir, "a.xml")})`,
      `Error while compiling 'same' (in file ${path.join(dir, "b.xml")})`,
      `Error while compiling 'also_bad' (in file ${path.join(dir, "b.xml")})`,
    ]);
    expect(failure.errors[1].cause.message).toContain("Duplicate template");
    expect(failure.errors[1].cause.message).toContain(path.join(dir, "a.xml"));
  });

  test("overlapping paths compile each file once in a deterministic order", async () => {
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(dir, "z.xml"), '<templates><t t-name="z"><p/></t></templates>');
    await writeFile(
      path.join(dir, "nested", "a.xml"),
      '<templates><t t-name="a"><p/></t></templates>'
    );
    const code = await compileTemplates([path.join(dir, "z.xml"), dir, path.join(dir, "nested")]);
    expect(getConsoleOutput()).toEqual(["log:2 templates compiled"]);
    const templates = new Function(code.replace("export const templates =", "return"))();
    expect(Object.keys(templates)).toEqual(["a", "z"]);
  });
});

test("npm run compile_templates runs the sources with Node, nothing built first", async () => {
  await writeFile(
    path.join(dir, "a.xml"),
    `<templates><t t-name="a"><p t-out="x"/></t></templates>`
  );
  const output = path.join(dir, "out", "templates.js");
  const run = runCompiler([dir, "-o", output]);
  expect(run.status).toBe(0);
  expect(run.stderr).toMatch(/OWL-COMPILE \d+:/);
  expect(run.stdout).toContain("1 templates compiled");
  const code = await readFile(output, "utf8");
  const templates = new Function(code.replace("export const templates =", "return"))();
  expect(Object.keys(templates)).toEqual(["a"]);
});

test.each(["XML", "directive", "duplicate", "missing input"] as const)(
  "the CLI preserves existing output and fails for %s errors",
  async (failure) => {
    const input = path.join(dir, "input.xml");
    const output = path.join(dir, "templates.js");
    const sentinel = "export const previous = true;";
    await writeFile(output, sentinel);
    const source =
      failure === "XML"
        ? "<templates><t>"
        : failure === "duplicate"
          ? '<templates><t t-name="a"><p/></t><t t-name="a"><span/></t></templates>'
          : '<templates><t t-name="good"><p/></t><t t-name="bad"><p t-unknown="true"/></t></templates>';
    if (failure !== "missing input") await writeFile(input, source);
    const run = runCompiler([input, "-o", output]);
    expect(run.status).toBe(1);
    expect(await readFile(output, "utf8")).toBe(sentinel);
    expect(run.stdout).not.toContain("templates compiled");
    expect(run.stderr).toContain(failure === "missing input" ? "ENOENT" : "AggregateError");
  }
);

test("the CLI rejects missing paths and creates no output", () => {
  const run = runCompiler(["-o", path.join(dir, "templates.js")]);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("Usage:");
});

test("a failed compilation creates neither the output nor its parent directory", async () => {
  const input = path.join(dir, "input.xml");
  const output = path.join(dir, "new", "templates.js");
  await writeFile(input, '<templates><t t-name="bad"><p t-unknown="true"/></t></templates>');
  const run = runCompiler([input, "-o", output]);
  expect(run.status).toBe(1);
  await expect(stat(path.dirname(output))).rejects.toHaveProperty("code", "ENOENT");
});

test("an output write failure preserves the directory and creates no temporary files", async () => {
  const input = path.join(dir, "input.xml");
  const output = path.join(dir, "existing-directory");
  await mkdir(output);
  await writeFile(path.join(output, "sentinel"), "untouched");
  await writeFile(input, '<templates><t t-name="good"><p/></t></templates>');
  const run = runCompiler([input, "-o", output]);
  expect(run.status).toBe(1);
  expect(await readFile(path.join(output, "sentinel"), "utf8")).toBe("untouched");
  expect((await readdir(dir)).filter((name) => name.startsWith(".owl-templates-"))).toEqual([]);
});

test("directory symlink cycles terminate and file aliases compile once", async () => {
  const nested = path.join(dir, "nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "a.xml"), '<templates><t t-name="a"><p/></t></templates>');
  await symlink(dir, path.join(nested, "cycle"));
  await symlink(path.join(nested, "a.xml"), path.join(dir, "alias.xml"));
  const output = path.join(dir, "templates.js");
  const run = runCompiler([dir, "-o", output]);
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("1 templates compiled");
  const code = await readFile(output, "utf8");
  const templates = new Function(code.replace("export const templates =", "return"))();
  expect(Object.keys(templates)).toEqual(["a"]);
});

test.each([false, true])(
  "the CLI writes through an output symlink (existing target: %s)",
  async (existing) => {
    const input = path.join(dir, "input.xml");
    const output = path.join(dir, "templates.js");
    const target = path.join(dir, "target.js");
    await writeFile(input, '<templates><t t-name="good"><p/></t></templates>');
    if (existing) await writeFile(target, "old output");
    await symlink("target.js", output);
    const run = runCompiler([input, "-o", output]);
    expect(run.status).toBe(0);
    expect((await lstat(output)).isSymbolicLink()).toBe(true);
    expect(await templateNamesInFile(target)).toEqual(["good"]);
  }
);

test("the CLI preserves an existing output's permissions", async () => {
  const input = path.join(dir, "input.xml");
  const output = path.join(dir, "templates.js");
  await writeFile(input, '<templates><t t-name="good"><p/></t></templates>');
  await writeFile(output, "old output");
  await chmod(output, 0o640);
  const run = runCompiler([input, "-o", output]);
  expect(run.status).toBe(0);
  expect((await stat(output)).mode & 0o777).toBe(0o640);
});

test("the CLI preserves hard-linked outputs", async () => {
  const input = path.join(dir, "input.xml");
  const output = path.join(dir, "templates.js");
  const other = path.join(dir, "linked.js");
  await writeFile(input, '<templates><t t-name="good"><p/></t></templates>');
  await writeFile(output, "old output");
  await link(output, other);
  const run = runCompiler([input, "-o", output]);
  expect(run.status).toBe(0);
  expect((await stat(output)).ino).toBe((await stat(other)).ino);
  expect(await templateNamesInFile(other)).toEqual(["good"]);
});
