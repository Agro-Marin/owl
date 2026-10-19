import { execSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { scratchDir } from "../../../tools/workspace.mjs";
import { buildDate, buildHash, sameSources } from "../build_hash.mjs";

const dirs: string[] = [];

function makeTree(files: Record<string, string>): string {
  const root = scratchDir("owl-build-hash");
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function makeRepo(files: Record<string, string>): string {
  const root = makeTree(files);
  const git = (command: string) => execSync(`git ${command}`, { cwd: root, stdio: "ignore" });
  git("init -q");
  git("add -A");
  git("-c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init");
  return root;
}

const SOURCES = {
  "packages/owl-core/src/a.ts": "export const a = 1;",
  "packages/owl-runtime/src/version.ts": 'export const version = "1";',
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean checkout is named by its commit, a changed source makes it dirty", () => {
  const root = makeRepo(SOURCES);
  const commit = execSync("git rev-parse --short=8 HEAD", { cwd: root }).toString().trim();
  expect(buildHash(root)).toBe(commit);
  writeFileSync(join(root, "packages/owl-core/src/a.ts"), "export const a = 2;");
  const dirty = buildHash(root);
  expect(dirty).toMatch(new RegExp(`^${commit}-dirty-[0-9a-f]{8}$`));
  writeFileSync(join(root, "packages/owl-core/src/a.ts"), "export const a = 3;");
  expect(buildHash(root)).not.toBe(dirty);
});

test("an untracked source makes a checkout dirty, by its content", () => {
  const root = makeRepo(SOURCES);
  writeFileSync(join(root, "packages/owl-core/src/b.ts"), "export const b = 1;");
  const first = buildHash(root);
  expect(first).toContain("-dirty-");
  writeFileSync(join(root, "packages/owl-core/src/b.ts"), "export const b = 2;");
  expect(buildHash(root)).not.toBe(first);
});

test("without a checkout, the sources are named by their digest", () => {
  const one = makeTree(SOURCES);
  const same = makeTree(SOURCES);
  const other = makeTree({ ...SOURCES, "packages/owl-core/src/a.ts": "export const a = 2;" });
  expect(buildHash(one)).toMatch(/^nogit-[0-9a-f]{8}$/);
  expect(buildHash(same)).toBe(buildHash(one));
  expect(buildHash(other)).not.toBe(buildHash(one));
});

test("a checkout of another repository around the sources does not name them", () => {
  const outer = makeRepo({ "README.md": "outer" });
  const root = join(outer, "owl");
  for (const [path, content] of Object.entries(SOURCES)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  expect(buildHash(root)).toMatch(/^nogit-[0-9a-f]{8}$/);
});

test("a clean build is dated by its commit", () => {
  const root = makeRepo(SOURCES);
  const committed = execSync("git log -1 --format=%cI", { cwd: root }).toString().trim();
  expect(buildDate(root, buildHash(root), {})).toBe(new Date(committed).toISOString());
});

test("SOURCE_DATE_EPOCH dates any build; a dirty or unversioned one is dated now", () => {
  const root = makeRepo(SOURCES);
  expect(buildDate(root, buildHash(root), { SOURCE_DATE_EPOCH: "1767225600" })).toBe(
    "2026-01-01T00:00:00.000Z"
  );
  writeFileSync(join(root, "packages/owl-core/src/a.ts"), "export const a = 2;");
  const before = Date.now();
  const dirty = Date.parse(buildDate(root, buildHash(root), {}));
  expect(dirty).toBeGreaterThanOrEqual(before - 1000);
  const tree = makeTree(SOURCES);
  expect(Date.parse(buildDate(tree, buildHash(tree), {}))).toBeGreaterThanOrEqual(before - 1000);
});

test("a malformed SOURCE_DATE_EPOCH is refused by name", () => {
  const tree = makeTree(SOURCES);
  for (const value of ["yesterday", "1.5e400", "-"]) {
    expect(() => buildDate(tree, buildHash(tree), { SOURCE_DATE_EPOCH: value })).toThrow(
      `SOURCE_DATE_EPOCH must be a number of seconds since 1970, not ${JSON.stringify(value)}`
    );
  }
});

test("a build has the same sources as a later commit only if no source changed in between", () => {
  const root = makeRepo({ ...SOURCES, "README.md": "one" });
  const git = (command: string) =>
    execSync(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${command}`, {
      cwd: root,
    })
      .toString()
      .trim();
  const built = buildHash(root);
  writeFileSync(join(root, "README.md"), "two");
  git("commit -q -am readme");
  expect(sameSources(root, built)).toBe(true);
  writeFileSync(join(root, "packages/owl-core/src/a.ts"), "export const a = 2;");
  expect(sameSources(root, built)).toBe(false);
  const dirty = buildHash(root);
  expect(sameSources(root, dirty)).toBe(true);
  git("commit -q -am source");
  expect(sameSources(root, built)).toBe(false);
  expect(sameSources(root, dirty)).toBe(false);
  expect(sameSources(root, "deadbeef")).toBe(false);
});
