import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildHash } from "../packages/owl/build_hash.mjs";
import { checkNodeVersion, defaultOdoo, ODOO_CANDIDATES, ROOT, scratchDir } from "./workspace.mjs";

export const FILES = ["owl.es.js", "owl.runtime.es.js", "owl.compiler.es.js"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function owlEntryRange(text) {
  const start = text.indexOf('"owl": {');
  if (start < 0) {
    throw new Error('versions.json has no "owl" entry');
  }
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
  throw new Error('versions.json: unterminated "owl" entry');
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
  for (const [file, checksum] of Object.entries(checksums)) {
    set(file, checksum);
  }
  const updated = text.slice(0, start) + entry + text.slice(end);
  JSON.parse(updated);
  return updated;
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
  const hash = buildHash(root);
  if (!/^[0-9a-f]{8}$/.test(hash)) {
    throw new Error(`refusing to vendor build ${hash}: commit the sources first`);
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  const lib = join(odoo, "addons/web/static/lib");
  const versionsFile = join(lib, "versions.json");
  if (!existsSync(versionsFile)) {
    throw new Error(`${versionsFile} not found: --odoo must name an Odoo checkout`);
  }
  const version = JSON.parse(readFileSync(join(root, "packages/owl/package.json"), "utf8")).version;
  const out = scratchDir("owl-vendor");
  try {
    execFileSync(process.execPath, ["build.mjs", "--outdir", out], {
      cwd: join(root, "packages/owl"),
      stdio: ["ignore", "ignore", "inherit"],
    });
    const built = Object.fromEntries(FILES.map((file) => [file, readFileSync(join(out, file))]));
    const checksums = Object.fromEntries(FILES.map((file) => [file, sha256(built[file])]));
    const versionsText = readFileSync(versionsFile, "utf8");
    const pinned = JSON.parse(versionsText).libs.owl;
    log(`owl ${version} at ${commit} (build ${hash}) -> ${join(lib, "owl")}`);
    if (!check) {
      for (const file of FILES) {
        copyFileSync(join(out, file), join(lib, "owl", file));
      }
      writeFileSync(versionsFile, updateVersions(versionsText, { version, commit, checksums }));
      log(`vendored ${FILES.join(", ")}; versions.json: commit ${pinned.commit} -> ${commit}`);
      return 0;
    }
    let differences = 0;
    for (const file of FILES) {
      const path = join(lib, "owl", file);
      const vendored = existsSync(path) ? readFileSync(path) : null;
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
  const odoo = values.odoo ? resolve(values.odoo) : defaultOdoo();
  if (!odoo) {
    console.error(`no Odoo checkout at ${ODOO_CANDIDATES.join(" or ")}: pass --odoo <path>`);
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
