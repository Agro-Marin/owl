import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EQUIVALENTS_FILE = join(import.meta.dirname, "equivalent.json");

export function normalize(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

export function mutantKey({ tool, file, line, operator, original, replacement }) {
  return [tool, file, line, operator, normalize(original), normalize(replacement)].join("\u0000");
}

let loaded = null;

export function loadEquivalents(path = EQUIVALENTS_FILE) {
  if (loaded?.path === path) {
    return loaded.map;
  }
  const entries = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  for (const entry of entries) {
    if (!entry.reason) {
      throw new Error(`${path}: an equivalent mutant has no reason: ${JSON.stringify(entry)}`);
    }
  }
  loaded = { path, map: new Map(entries.map((entry) => [mutantKey(entry), entry])) };
  return loaded.map;
}

export function isEquivalent(equivalents, mutant) {
  const entry = equivalents.get(mutantKey(mutant));
  if (entry) {
    entry.matched = true;
  }
  return Boolean(entry);
}

export function staleEquivalents(equivalents, files, tools) {
  return [...equivalents.values()].filter(
    (entry) => files.includes(entry.file) && tools.includes(entry.tool) && !entry.matched
  );
}
