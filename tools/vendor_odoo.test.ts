import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinErrors, releaseVersion, updateVersions, vendor } from "./vendor_odoo.mjs";
import { scratchDir } from "./workspace.mjs";

const VERSIONS = `{
  "libs": {
    "ace": { "version": "1.0", "probe": { "file": "ace.js", "pattern": "v{version}" } },
    "owl": {
      "version": "3.0.0-alpha.1",
      "commit": "1111111111111111111111111111111111111111",
      "checksums": {
        "owl.es.js": "aa",
        "owl.runtime.es.js": "bb",
        "owl.compiler.es.js": "cc"
      },
      "notes": "a \\"quoted\\" { brace"
    },
    "pdfjs": { "version": "6.1", "commit": "keep" }
  }
}
`;

test("versions.json keeps its layout: only the owl entry's version, commit and checksums change", () => {
  const updated = updateVersions(VERSIONS, {
    version: "3.0.0-alpha.2",
    commit: "2222222222222222222222222222222222222222",
    checksums: { "owl.es.js": "dd", "owl.runtime.es.js": "ee", "owl.compiler.es.js": "ff" },
  });
  expect(updated).toBe(
    VERSIONS.replace("3.0.0-alpha.1", "3.0.0-alpha.2")
      .replace(
        "1111111111111111111111111111111111111111",
        "2222222222222222222222222222222222222222"
      )
      .replace('"aa"', '"dd"')
      .replace('"bb"', '"ee"')
      .replace('"cc"', '"ff"')
  );
});

test("a stray checksum pin is dropped: the owl entry pins exactly the three builds", () => {
  const stray = VERSIONS.replace(
    '"owl.es.js": "aa",',
    '"owl.es.js": "aa",\n        "owl.iife.js": "zz",'
  );
  const checksums = { "owl.es.js": "dd", "owl.runtime.es.js": "ee", "owl.compiler.es.js": "ff" };
  const commit = "2222222222222222222222222222222222222222";
  expect(updateVersions(stray, { version: "3.0.0-alpha.1", commit, checksums })).toBe(
    updateVersions(VERSIONS, { version: "3.0.0-alpha.1", commit, checksums })
  );
});

test("a versions.json without owl checksums is refused", () => {
  expect(() =>
    updateVersions('{ "libs": { "owl": { "version": "1", "commit": "c" } } }', {
      version: "2",
      commit: "d",
      checksums: { "owl.es.js": "x" },
    })
  ).toThrow('the "owl" entry has no "checksums"');
});

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const bundle = (version: string, hash = COMMIT.slice(0, 8)) =>
  Buffer.from(`var __x = 1;\nvar version = "${version}";\nvar buildHash = "${hash}";\n`);
const builds = (version: string, hash?: string) => ({
  "owl.es.js": bundle(version, hash),
  "owl.runtime.es.js": bundle(version, hash),
  "owl.compiler.es.js": bundle(version, hash),
});
const PIN = {
  version: "3.0.0-alpha.2",
  commit: COMMIT,
  checksums: { "owl.es.js": "a", "owl.runtime.es.js": "b", "owl.compiler.es.js": "c" },
  probe: { file: "owl.es.js", pattern: 'var version = "{version}"' },
};

test("the version is the build's, and a package.json that disagrees with it is refused", () => {
  expect(releaseVersion("3.0.0-alpha.2", builds("3.0.0-alpha.2"))).toBe("3.0.0-alpha.2");
  expect(() => releaseVersion("3.0.0-alpha.3", builds("3.0.0-alpha.2"))).toThrow(
    "owl.es.js is version 3.0.0-alpha.2 (packages/owl-runtime/src/version.ts) but packages/owl/package.json says 3.0.0-alpha.3"
  );
  expect(() => releaseVersion("1", { "owl.es.js": Buffer.from("var other = 1;") })).toThrow(
    "owl.es.js declares no `var version"
  );
});

test("the pins are judged as Odoo's checker judges them", () => {
  expect(pinErrors(PIN, builds("3.0.0-alpha.2"))).toEqual([]);
  expect(
    pinErrors(
      { ...PIN, checksums: { ...PIN.checksums, "owl.iife.js": "d" } },
      builds("3.0.0-alpha.2")
    )
  ).toEqual([
    "checksums pin owl.es.js, owl.runtime.es.js, owl.compiler.es.js, owl.iife.js: they must pin exactly owl.es.js, owl.runtime.es.js, owl.compiler.es.js",
  ]);
  expect(pinErrors(PIN, builds("3.0.0-alpha.20"))).toEqual([
    "owl.es.js does not match its pinned probe (version 3.0.0-alpha.2)",
  ]);
  expect(pinErrors({ ...PIN, version: "3.0.0-alpha+2" }, builds("3.0.0-alpha+2"))).toEqual([]);
  expect(pinErrors({ ...PIN, probe: undefined }, builds("3.0.0-alpha.3"))).toEqual([
    "owl.es.js does not match its pinned probe (version 3.0.0-alpha.2)",
  ]);
  expect(pinErrors(PIN, builds("3.0.0-alpha.2", "12345678"))).toEqual(
    ["owl.es.js", "owl.runtime.es.js", "owl.compiler.es.js"].map(
      (file) => `${file} does not identify commit ${COMMIT} (no \`var buildHash = "abcdef01";\`)`
    )
  );
  expect(pinErrors({ ...PIN, commit: "abcdef01" }, builds("3.0.0-alpha.2"))).toEqual([
    "commit abcdef01 is not a full SHA-1",
  ]);
});

function scratchRepo(files: Record<string, string>): string {
  const root = scratchDir("owl-vendor-test");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const git = (command: string) => execSync(`git ${command}`, { cwd: root, stdio: "ignore" });
  git("init -q");
  git("add -A");
  git("-c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init");
  return root;
}

const TREE = {
  "packages/owl-core/src/a.ts": "export const a = 1;",
  "packages/owl/build_target.mjs": 'export const TARGET = ["chrome154"];',
  "package-lock.json": "{}",
};

test.each([
  [
    "a source",
    "packages/owl-core/src/a.ts",
    "export const a = 2;",
    " M packages/owl-core/src/a.ts",
  ],
  [
    "the build target",
    "packages/owl/build_target.mjs",
    "export const TARGET = [];",
    " M packages/owl/build_target.mjs",
  ],
  ["the lockfile", "package-lock.json", '{"x":1}', " M package-lock.json"],
  [
    "an untracked source",
    "packages/owl-core/src/b.ts",
    "export const b = 1;",
    "?? packages/owl-core/src/b.ts",
  ],
])("a checkout with a change to %s is not vendored", (_, path, content, entry) => {
  const root = scratchRepo(TREE);
  try {
    writeFileSync(join(root, path), content);
    expect(() => vendor({ odoo: root, check: true, root, log: () => {} })).toThrow(
      `refusing to vendor: the checkout differs from its commit (${entry}): commit it first`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an untracked file outside the sources does not stop vendoring", () => {
  const root = scratchRepo(TREE);
  try {
    mkdirSync(join(root, "tools/odoo_migration/__pycache__"), { recursive: true });
    writeFileSync(join(root, "tools/odoo_migration/__pycache__/x.pyc"), "junk");
    expect(() => vendor({ odoo: root, check: true, root, log: () => {} })).toThrow(
      "addons/web/static/lib/versions.json not found: --odoo must name an Odoo checkout"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
