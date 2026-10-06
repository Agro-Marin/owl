import { execSync } from "child_process";
import { createHash } from "crypto";
import { readdirSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";

export const SOURCES = ["owl-core", "owl-compiler", "owl-runtime", "owl"].map(
  (p) => `packages/${p}/src`
);

// written by tools/release.cjs before it builds and commits: the version is
// named next to the hash already (App.version), so it is not a change
export const GENERATED = ["packages/owl-runtime/src/version.ts"];

function digest(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest("hex").slice(0, 8);
}

function sourceFiles(root, dir) {
  let entries;
  try {
    entries = readdirSync(resolve(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      return entry.isDirectory() ? sourceFiles(root, path) : [path];
    });
}

/**
 * The build's name: the commit, with a digest of the uncommitted changes to
 * the sources when there are any; outside a git checkout of `root`, a digest
 * of the sources. Odoo keys its persistent cache of compiled templates on it,
 * and the compiler module must be of the runtime's build: two builds of
 * different code must not share a name.
 *
 * @param {string} root the repository's root
 * @returns {string}
 */
export function buildHash(root) {
  root = realpathSync(root);
  const git = (command) =>
    execSync(`git ${command}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  let commit;
  try {
    // a checkout of another repository around this one names none of its code
    if (realpathSync(git("rev-parse --show-toplevel")) !== root) {
      throw new Error("not the root of a checkout");
    }
    commit = git("rev-parse --short=8 HEAD");
  } catch {
    const files = SOURCES.flatMap((dir) => sourceFiles(root, dir));
    return `nogit-${digest(...files.flatMap((file) => [file, "\0", readFileSync(join(root, file)), "\0"]))}`;
  }
  const pathspec = [...SOURCES, ...GENERATED.map((file) => `':(exclude)${file}'`)].join(" ");
  const changes = git(`diff HEAD -- ${pathspec}`);
  const untracked = git(`ls-files --others --exclude-standard -- ${pathspec}`)
    .split("\n")
    .filter(Boolean);
  if (!changes && !untracked.length) {
    return commit;
  }
  const contents = untracked.flatMap((file) => [file, "\0", readFileSync(join(root, file)), "\0"]);
  return `${commit}-dirty-${digest(changes, "\0", ...contents)}`;
}
