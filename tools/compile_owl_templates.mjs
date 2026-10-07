#!/usr/bin/env node

// `npm run compile_templates -- <paths>`: compiles the templates of the xml
// files under <paths> into a templates.js module (see
// doc/v3/owl/reference/precompiling_templates.md). It runs the compiler's
// TypeScript sources directly: nothing to build first.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import "./ts_hooks.mjs";

const { compileTemplates } = await import("../packages/owl-compiler/src/standalone/index.ts");

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
  const result = await compileTemplates(positionals);
  const outputPath = values.output;
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outputPath, result);
} else {
  console.log("Please provide a path");
}
