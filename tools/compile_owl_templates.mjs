#!/usr/bin/env node

// `npm run compile_templates -- <paths>`: compiles the templates of the xml
// files under <paths> into a templates.js module (see
// doc/v3/owl/reference/precompiling_templates.md). Needs `npm run build:compiler`.
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { compileTemplates } from "../packages/owl-compiler/dist/compile_templates.mjs";
import { parseArgs } from "util";

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
