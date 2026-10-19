import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

export const ROOT = at("");

export const PACKAGE_SOURCES = {
  "@odoo/owl-core": at("packages/owl-core/src/index.ts"),
  "@odoo/owl-compiler": at("packages/owl-compiler/src/index.ts"),
  "@odoo/owl-runtime": at("packages/owl-runtime/src/index.ts"),
};

export const REQUIRED_NODE = Number(readFileSync(at(".node-version"), "utf8").trim());

export function checkNodeVersion() {
  const found = Number(process.versions.node.split(".")[0]);
  if (found < REQUIRED_NODE) {
    throw new Error(
      `Owl needs Node >=${REQUIRED_NODE} (found ${process.version}; see .node-version)`
    );
  }
}

export const TEST_DEFAULTS = {
  root: ".",
  globals: true,
  testTimeout: 10000,
  globalSetup: [at("tools/testing/node_version.mjs")],
  expect: { requireAssertions: true },
};
