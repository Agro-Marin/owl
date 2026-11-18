import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changelogSection, compareVersions, release } from "./release.mjs";
import { scratchDir } from "./workspace.mjs";

test("versions are ordered as semver orders them", () => {
  expect(compareVersions("3.0.0-marin.1", "3.0.0-alpha.49")).toBeGreaterThan(0);
  expect(compareVersions("3.0.0-marin.10", "3.0.0-marin.9")).toBeGreaterThan(0);
  expect(compareVersions("3.0.0", "3.0.0-marin.5")).toBeGreaterThan(0);
  expect(compareVersions("3.0.0-marin.1", "3.0.0-marin.1")).toBe(0);
  expect(compareVersions("3.0.0-marin", "3.0.0-marin.1")).toBeLessThan(0);
  expect(() => compareVersions("3.0", "3.0.0")).toThrow("not a version: 3.0");
});

test("a changelog entry escapes what the docs site would read as an element or an interpolation", () => {
  expect(
    changelogSection("1.0.0", "d", ["[FIX] compiler: a <t> with t-attf {{ x }} -> y"])
  ).toContain("- compiler: a &lt;t&gt; with t-attf &#123;&#123; x }} -&gt; y\n");
});

test("a changelog section groups the commit subjects by their tag", () => {
  expect(
    changelogSection("3.0.0-marin.1", "2026-11-18", [
      "[IMP] tools: a",
      "[FIX] owl-core: b",
      "plain subject",
      "[FIX] owl-runtime: c",
    ])
  ).toBe(
    [
      "## 3.0.0-marin.1 (2026-11-18)",
      "",
      "### FIX",
      "",
      "- owl-core: b",
      "- owl-runtime: c",
      "",
      "### IMP",
      "",
      "- tools: a",
      "",
      "### OTHER",
      "",
      "- plain subject",
      "",
    ].join("\n")
  );
});

function scratchRepo(): { root: string; git: (...args: string[]) => string } {
  const root = scratchDir("owl-release-test");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  mkdirSync(join(root, "packages/owl-runtime/src"), { recursive: true });
  writeFileSync(
    join(root, "packages/owl-runtime/src/version.ts"),
    'export const version = "3.0.0-alpha.49";\n'
  );
  for (const name of ["owl", "owl-compiler", "owl-core", "owl-runtime"]) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    const data: any = { name: `@odoo/${name}`, version: "3.0.0-alpha.49" };
    if (name === "owl") {
      data.devDependencies = { "@odoo/owl-core": "3.0.0-alpha.49", jsdom: "^25.0.1" };
    }
    writeFileSync(
      join(root, "packages", name, "package.json"),
      JSON.stringify(data, null, 2) + "\n"
    );
  }
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify(
      {
        packages: {
          "": { name: "owl-monorepo" },
          "packages/owl": {
            version: "3.0.0-alpha.49",
            devDependencies: { "@odoo/owl-core": "3.0.0-alpha.49", jsdom: "^25.0.1" },
          },
          "packages/owl-core": { version: "3.0.0-alpha.49" },
        },
      },
      null,
      2
    ) + "\n"
  );
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { root, git };
}

test("a release writes the version everywhere, lists the commits since the last release, commits and tags", async () => {
  const { root, git } = scratchRepo();
  try {
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "a.txt"), "a");
    git("add", "a.txt");
    git("commit", "-q", "-m", "[FIX] owl-core: first fix");
    await release({ root, version: "3.0.0-marin.1", date: "2026-11-18", base, log: () => {} });
    expect(readFileSync(join(root, "packages/owl-runtime/src/version.ts"), "utf8")).toBe(
      'export const version = "3.0.0-marin.1";\n'
    );
    const owl = JSON.parse(readFileSync(join(root, "packages/owl/package.json"), "utf8"));
    expect(owl.version).toBe("3.0.0-marin.1");
    expect(owl.devDependencies).toEqual({ "@odoo/owl-core": "3.0.0-marin.1", jsdom: "^25.0.1" });
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    expect(lock.packages["packages/owl"].devDependencies["@odoo/owl-core"]).toBe("3.0.0-marin.1");
    expect(lock.packages["packages/owl-core"].version).toBe("3.0.0-marin.1");
    expect(git("log", "-1", "--format=%s")).toBe("[REL] v3.0.0-marin.1");
    expect(git("tag", "--list")).toBe("v3.0.0-marin.1");
    expect(git("status", "--porcelain")).toBe("");
    const changelog = readFileSync(join(root, "doc/v3/owl/changelog_marin.md"), "utf8");
    expect(changelog).toContain(
      "## 3.0.0-marin.1 (2026-11-18)\n\n### FIX\n\n- owl-core: first fix\n"
    );

    writeFileSync(join(root, "b.txt"), "b");
    git("add", "b.txt");
    git("commit", "-q", "-m", "[IMP] tools: second, *emphasis* and a_b and   spaces");
    await release({ root, version: "3.0.0-marin.2", date: "2026-11-19", base, log: () => {} });
    const second = readFileSync(join(root, "doc/v3/owl/changelog_marin.md"), "utf8");
    expect(second.indexOf("## 3.0.0-marin.2")).toBeLessThan(second.indexOf("## 3.0.0-marin.1"));
    expect(second.split("## 3.0.0-marin.1")[0]).not.toContain("first fix");
    expect(second.split("## 3.0.0-marin.1")[0]).toContain("- tools: second");
    const { check } = await import("prettier");
    expect(await check(second, { filepath: join(root, "doc/v3/owl/changelog_marin.md") })).toBe(
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a release refuses a version that does not follow the current one, and a dirty checkout", async () => {
  const { root } = scratchRepo();
  try {
    await expect(
      release({ root, version: "3.0.0-alpha.48", date: "d", log: () => {} })
    ).rejects.toThrow("refusing to release 3.0.0-alpha.48: it does not follow 3.0.0-alpha.49");
    writeFileSync(join(root, "packages/owl/package.json"), "{}\n");
    await expect(
      release({ root, version: "3.0.0-marin.1", date: "d", log: () => {} })
    ).rejects.toThrow("refusing to release: the checkout differs from its commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
