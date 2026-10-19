import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateVersions, vendor } from "./vendor_odoo.mjs";
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

test("a versions.json without an owl checksum is refused", () => {
  expect(() =>
    updateVersions('{ "libs": { "owl": { "version": "1", "commit": "c" } } }', {
      version: "2",
      commit: "d",
      checksums: { "owl.es.js": "x" },
    })
  ).toThrow('the "owl" entry has no "owl.es.js"');
});

test("a checkout whose sources differ from its commit is not vendored", () => {
  const root = scratchDir("owl-vendor-test");
  try {
    mkdirSync(join(root, "packages/owl-core/src"), { recursive: true });
    writeFileSync(join(root, "packages/owl-core/src/a.ts"), "export const a = 1;");
    const git = (command: string) => execSync(`git ${command}`, { cwd: root, stdio: "ignore" });
    git("init -q");
    git("add -A");
    git("-c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init");
    writeFileSync(join(root, "packages/owl-core/src/a.ts"), "export const a = 2;");
    expect(() => vendor({ odoo: root, check: true, root, log: () => {} })).toThrow(
      /^refusing to vendor build [0-9a-f]{8}-dirty-[0-9a-f]{8}: commit the sources first$/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
