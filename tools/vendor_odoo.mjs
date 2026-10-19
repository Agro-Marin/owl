import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildHash, SOURCES } from "../packages/owl/build_hash.mjs";
import { checkNodeVersion, ROOT, scratchDir, SIBLING_ODOO } from "./workspace.mjs";

export const FILES = ["owl.es.js", "owl.runtime.es.js", "owl.compiler.es.js"];
export const DEFAULT_PROBE = { file: "owl.es.js", pattern: 'var version = "{version}"' };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString();

function objectRange(text, start, what) {
  let depth = 0;
  let inString = false;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return [start, i + 1];
  }
  throw new Error(`versions.json: unterminated ${what}`);
}

function owlEntryRange(text) {
  const start = text.indexOf('"owl": {');
  if (start < 0) {
    throw new Error('versions.json has no "owl" entry');
  }
  return objectRange(text, start, '"owl" entry');
}

function replaceChecksums(entry, checksums) {
  const start = entry.indexOf('"checksums": {');
  if (start < 0) {
    throw new Error('versions.json: the "owl" entry has no "checksums"');
  }
  const [, end] = objectRange(entry, start, '"checksums" object');
  const body = entry.slice(entry.indexOf("{", start) + 1, end - 1);
  const indent = /^\n?([ \t]*)/.exec(body)[1];
  const closing = /\n([ \t]*)$/.exec(body)?.[1] ?? "";
  const lines = Object.entries(checksums).map(
    ([file, checksum]) => `${indent}${JSON.stringify(file)}: ${JSON.stringify(checksum)}`
  );
  return `${entry.slice(0, start)}"checksums": {\n${lines.join(",\n")}\n${closing}}${entry.slice(end)}`;
}

export function updateVersions(text, { version, commit, checksums }) {
  const [start, end] = owlEntryRange(text);
  let entry = text.slice(start, end);
  const set = (key, value) => {
    const re = new RegExp(`("${key.replaceAll(".", "\\.")}": )"[^"]*"`);
    if (!re.test(entry)) {
      throw new Error(`versions.json: the "owl" entry has no "${key}"`);
    }
    entry = entry.replace(re, `$1${JSON.stringify(value)}`);
  };
  set("version", version);
  set("commit", commit);
  entry = replaceChecksums(entry, checksums);
  const updated = text.slice(0, start) + entry + text.slice(end);
  JSON.parse(updated);
  return updated;
}

export function bundleVersion(file, text) {
  const match = /^var version = "([^"]*)";$/m.exec(text);
  if (!match) {
    throw new Error(`${file} declares no \`var version = "…";\``);
  }
  return match[1];
}

export function releaseVersion(packageVersion, built) {
  for (const [file, bytes] of Object.entries(built)) {
    const version = bundleVersion(file, bytes.toString("utf8"));
    if (version !== packageVersion) {
      throw new Error(
        `${file} is version ${version} (packages/owl-runtime/src/version.ts) but ` +
          `packages/owl/package.json says ${packageVersion}: make them equal and commit`
      );
    }
  }
  return packageVersion;
}

export function pinErrors(pin, files) {
  const errors = [];
  const pinned = Object.keys(pin.checksums ?? {});
  if (pinned.length !== FILES.length || !FILES.every((file) => pinned.includes(file))) {
    errors.push(`checksums pin ${pinned.join(", ")}: they must pin exactly ${FILES.join(", ")}`);
  }
  if (!/^[0-9a-f]{40}$/.test(pin.commit ?? "")) {
    return [...errors, `commit ${pin.commit} is not a full SHA-1`];
  }
  const buildHash = `var buildHash = "${pin.commit.slice(0, 8)}";`;
  for (const file of FILES) {
    if (files[file] && !files[file].toString("utf8").includes(buildHash)) {
      errors.push(`${file} does not identify commit ${pin.commit} (no \`${buildHash}\`)`);
    }
  }
  const probe = pin.probe ?? DEFAULT_PROBE;
  const pattern = new RegExp(
    probe.pattern.replaceAll("{version}", escapeRegExp(pin.version ?? "")),
    "m"
  );
  if (!files[probe.file]) {
    errors.push(`missing version probe ${probe.file}`);
  } else if (!pattern.test(files[probe.file].toString("utf8"))) {
    errors.push(`${probe.file} does not match its pinned probe (version ${pin.version})`);
  }
  return errors;
}

export function uncommittedChanges(root) {
  const changed = git(root, "status", "--porcelain", "--untracked-files=no")
    .split("\n")
    .filter(Boolean);
  const untracked = git(root, "ls-files", "--others", "--exclude-standard", "--", ...SOURCES)
    .split("\n")
    .filter(Boolean)
    .map((file) => `?? ${file}`);
  return [...changed, ...untracked];
}

function firstDifferences(built, vendored, limit = 3) {
  const a = built.toString("utf8").split("\n");
  const b = vendored.toString("utf8").split("\n");
  const lines = [];
  for (let i = 0; i < Math.max(a.length, b.length) && lines.length < limit; i++) {
    if (a[i] !== b[i]) {
      lines.push(`    line ${i + 1}: built ${JSON.stringify(a[i]?.trim().slice(0, 80))}`);
      lines.push(
        `    ${" ".repeat(String(i + 1).length + 5)}  vendored ${JSON.stringify(b[i]?.trim().slice(0, 80))}`
      );
    }
  }
  return lines;
}

export function vendor({ odoo, check, root = ROOT, log = console.log }) {
  checkNodeVersion();
  if (buildHash(root).startsWith("nogit-")) {
    throw new Error(`refusing to vendor: ${root} is not the root of a git checkout`);
  }
  const changes = uncommittedChanges(root);
  if (changes.length) {
    throw new Error(
      `refusing to vendor: the checkout differs from its commit (${changes.join(", ")}): commit it first`
    );
  }
  const hash = buildHash(root);
  const commit = git(root, "rev-parse", "HEAD").trim();
  const lib = join(odoo, "addons/web/static/lib");
  const versionsFile = join(lib, "versions.json");
  if (!existsSync(versionsFile)) {
    throw new Error(`${versionsFile} not found: --odoo must name an Odoo checkout`);
  }
  const packageVersion = JSON.parse(
    readFileSync(join(root, "packages/owl/package.json"), "utf8")
  ).version;
  const out = scratchDir("owl-vendor");
  try {
    execFileSync(process.execPath, ["build.mjs", "--outdir", out], {
      cwd: join(root, "packages/owl"),
      stdio: ["ignore", "ignore", "inherit"],
    });
    const built = Object.fromEntries(FILES.map((file) => [file, readFileSync(join(out, file))]));
    const version = releaseVersion(packageVersion, built);
    const checksums = Object.fromEntries(FILES.map((file) => [file, sha256(built[file])]));
    const versionsText = readFileSync(versionsFile, "utf8");
    const pinned = JSON.parse(versionsText).libs.owl;
    log(`owl ${version} at ${commit} (build ${hash}) -> ${join(lib, "owl")}`);
    if (!check) {
      const updated = updateVersions(versionsText, { version, commit, checksums });
      const errors = pinErrors(JSON.parse(updated).libs.owl, built);
      if (errors.length) {
        throw new Error(`refusing to vendor: Odoo's checker would reject it: ${errors.join("; ")}`);
      }
      for (const file of FILES) {
        copyFileSync(join(out, file), join(lib, "owl", file));
      }
      writeFileSync(versionsFile, updated);
      log(`vendored ${FILES.join(", ")}; versions.json: commit ${pinned.commit} -> ${commit}`);
      return 0;
    }
    let differences = 0;
    const vendoredFiles = {};
    for (const file of FILES) {
      const path = join(lib, "owl", file);
      const vendored = existsSync(path) ? readFileSync(path) : null;
      vendoredFiles[file] = vendored;
      if (vendored && vendored.equals(built[file])) {
        log(`  same      ${file}`);
      } else {
        differences++;
        log(`  differs   ${file}${vendored ? "" : " (not vendored)"}`);
        if (vendored) log(firstDifferences(built[file], vendored).join("\n"));
      }
      if (pinned.checksums?.[file] !== checksums[file]) {
        differences++;
        log(
          `  differs   versions.json checksum of ${file}: ${pinned.checksums?.[file]}, built ${checksums[file]}`
        );
      }
    }
    for (const [key, value] of [
      ["commit", commit],
      ["version", version],
    ]) {
      if (pinned[key] !== value) {
        differences++;
        log(`  differs   versions.json ${key}: ${pinned[key]}, built ${value}`);
      }
    }
    for (const error of pinErrors(pinned, vendoredFiles)) {
      differences++;
      log(`  rejected  ${error}`);
    }
    log(differences ? `${differences} difference(s)` : "the vendored build is this checkout's");
    return differences ? 1 : 0;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { check: { type: "boolean", default: false }, odoo: { type: "string" } },
  });
  const odoo = resolve(values.odoo ?? SIBLING_ODOO);
  if (!existsSync(join(odoo, "addons/web"))) {
    console.error(
      `no Odoo checkout at ${odoo}` +
        (values.odoo ? "" : " (beside this one)") +
        ": pass --odoo <path>"
    );
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = vendor({ odoo, check: values.check });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
    }
  }
}
