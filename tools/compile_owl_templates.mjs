#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { debuglog, parseArgs } from "node:util";
import "./ts_hooks.mjs";

const { compileTemplates } = await import("../packages/owl-compiler/src/standalone/index.ts");
const log = debuglog("owl-compile");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: {
      type: "string",
      short: "o",
      default: "templates.js",
    },
  },
});

if (positionals.length) {
  try {
    const result = await compileTemplates(positionals);
    const outputPath = values.output;
    const dir = dirname(outputPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, result);
    log("wrote %d bytes to %s", Buffer.byteLength(result), outputPath);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
} else {
  console.error("Usage: npm run compile_templates -- <paths...> [-o <path>]");
  process.exitCode = 1;
}
