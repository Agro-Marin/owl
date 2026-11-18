import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EQUIVALENTS_FILE = join(import.meta.dirname, "equivalent.json");

export function normalize(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

export function mutantKey({ tool, file, line, operator, original, replacement }) {
  return [tool, file, line, operator, normalize(original), normalize(replacement)].join("\u0000");
}

// How far an entry may have moved since it was written: edits above it shift
// its line, and an equivalent mutant is the same mutant a few lines away.
export const LINE_TOLERANCE = 80;

function textKey({ tool, file, operator, original, replacement }) {
  return [tool, file, operator, normalize(original), normalize(replacement)].join("\u0000");
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
  const map = new Map();
  for (const entry of entries) {
    map.getOrInsertComputed(textKey(entry), () => []).push(entry);
  }
  loaded = { path, entries, map };
  return map;
}

// The entry for a mutant: the same text at the same line, else the unmatched
// one nearest its line within LINE_TOLERANCE. A matched entry records the line
// it now sits at (writeEquivalentLines saves them).
export function isEquivalent(equivalents, mutant) {
  const candidates = (equivalents.get(textKey(mutant)) ?? []).filter((entry) => !entry.matched);
  let best = null;
  for (const entry of candidates) {
    const distance = Math.abs(entry.line - mutant.line);
    if (distance <= LINE_TOLERANCE && (!best || distance < Math.abs(best.line - mutant.line))) {
      best = entry;
    }
  }
  if (best) {
    best.matched = true;
    best.currentLine = mutant.line;
  }
  return Boolean(best);
}

export function staleEquivalents(equivalents, files, tools) {
  return [...equivalents.values()]
    .flat()
    .filter((entry) => files.includes(entry.file) && tools.includes(entry.tool) && !entry.matched);
}

// Moves each matched entry to the line its mutant was found at, so the next
// run matches exactly; returns how many moved.
export function writeEquivalentLines(path = EQUIVALENTS_FILE) {
  if (loaded?.path !== path) {
    return 0;
  }
  let moved = 0;
  const entries = loaded.entries.map(({ matched, currentLine, ...entry }) => {
    if (matched && currentLine !== undefined && currentLine !== entry.line) {
      moved++;
      return { ...entry, line: currentLine };
    }
    return entry;
  });
  if (moved) {
    writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
  }
  return moved;
}
