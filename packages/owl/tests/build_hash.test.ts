import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildHash } from "../build_hash.mjs";

const dirs: string[] = [];

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "owl-build-hash-"));
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

test("the version the release script writes before building is not a change", () => {
  const root = makeRepo(SOURCES);
  const clean = buildHash(root);
  writeFileSync(join(root, "packages/owl-runtime/src/version.ts"), 'export const version = "2";');
  expect(buildHash(root)).toBe(clean);
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
