import { execSync } from "child_process";
import { createHash } from "crypto";
import { readdirSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";

export const SOURCES = ["owl-core", "owl-compiler", "owl-runtime", "owl"].map(
  (p) => `packages/${p}/src`
);

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

function git(root, command) {
  return execSync(`git ${command}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

export function buildHash(root) {
  root = realpathSync(root);
  let commit;
  try {
    if (realpathSync(git(root, "rev-parse --show-toplevel")) !== root) {
      throw new Error("not the root of a checkout");
    }
    commit = git(root, "rev-parse --short=8 HEAD");
  } catch {
    const files = SOURCES.flatMap((dir) => sourceFiles(root, dir));
    return `nogit-${digest(...files.flatMap((file) => [file, "\0", readFileSync(join(root, file)), "\0"]))}`;
  }
  const pathspec = SOURCES.join(" ");
  const changes = git(root, `diff HEAD -- ${pathspec}`);
  const untracked = git(root, `ls-files --others --exclude-standard -- ${pathspec}`)
    .split("\n")
    .filter(Boolean);
  if (!changes && !untracked.length) {
    return commit;
  }
  const contents = untracked.flatMap((file) => [file, "\0", readFileSync(join(root, file)), "\0"]);
  return `${commit}-dirty-${digest(changes, "\0", ...contents)}`;
}

export function sameSources(root, built, current = buildHash(root)) {
  if (built === current) {
    return true;
  }
  if (![built, current].every((hash) => /^[0-9a-f]{8}$/.test(hash))) {
    return false;
  }
  try {
    git(realpathSync(root), `diff --quiet ${built} ${current} -- ${SOURCES.join(" ")}`);
    return true;
  } catch {
    return false;
  }
}

export function buildDate(root, hash = buildHash(root), env = process.env) {
  if (env.SOURCE_DATE_EPOCH) {
    const date = new Date(Number(env.SOURCE_DATE_EPOCH) * 1000);
    if (!/^\d+$/.test(env.SOURCE_DATE_EPOCH) || Number.isNaN(date.getTime())) {
      throw new Error(
        `SOURCE_DATE_EPOCH must be a number of seconds since 1970, not ${JSON.stringify(env.SOURCE_DATE_EPOCH)}`
      );
    }
    return date.toISOString();
  }
  if (/^[0-9a-f]{8}$/.test(hash)) {
    return new Date(git(realpathSync(root), "log -1 --format=%cI HEAD")).toISOString();
  }
  return new Date().toISOString();
}
