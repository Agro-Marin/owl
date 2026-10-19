import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

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

export const SIBLING_ODOO = resolve(ROOT, "../odoo");

export const ODOO_CANDIDATES = [SIBLING_ODOO, "/home/marin/Odoo/odoo"];

export function defaultOdoo() {
  return ODOO_CANDIDATES.find((dir) => existsSync(join(dir, "addons/web")));
}

export function scratchDir(prefix) {
  const parent = join(ROOT, "temp");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `${prefix}-`));
}

export const TEST_DEFAULTS = {
  root: ".",
  globals: true,
  testTimeout: 10000,
  globalSetup: [at("tools/testing/node_version.mjs")],
  expect: { requireAssertions: true },
};
