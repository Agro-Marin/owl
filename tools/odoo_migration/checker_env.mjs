import fs from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { defaultOdoo, ROOT } from "../workspace.mjs";

export const require = createRequire(import.meta.url);

function refuse(message) {
  console.error(message);
  process.exit(2);
}

export function installDom() {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  globalThis.window = dom.window;
  for (const k of Object.getOwnPropertyNames(dom.window)) {
    if (!(k in globalThis)) {
      try {
        globalThis[k] = dom.window[k];
      } catch {}
    }
  }
  return dom;
}

export function owlBuild() {
  const owl = resolve(process.env.OWL || ROOT);
  const build = ["packages/owl/dist/owl.es.js", "dist/owl.es.js"]
    .map((path) => join(owl, path))
    .find((path) => fs.existsSync(path));
  if (!build) {
    refuse(
      `no Owl build in ${owl} (OWL names the Owl checkout to check, default this one): ` +
        "run `npm run build` there"
    );
  }
  return build;
}

export function webAddon() {
  const odoo = defaultOdoo();
  const web = resolve(process.env.WEB || (odoo ? join(odoo, "addons/web") : "."));
  if (!fs.existsSync(join(web, "static/src/core/template_inheritance.js"))) {
    refuse(
      `${web} is not Odoo's web addon (no static/src/core/template_inheritance.js): ` +
        "set WEB to <odoo>/addons/web"
    );
  }
  return web;
}

export function oldBuild(web) {
  const old = resolve(process.env.OLD || join(web, "static/lib/owl/owl.es.js"));
  if (!fs.existsSync(old)) {
    refuse(`${old} not found: set OLD to the owl.es.js of the build to compare with`);
  }
  return old;
}

export function requireFromOdoo(web, name) {
  const path = join(web, "../../node_modules", name);
  if (!fs.existsSync(path)) {
    refuse(`${path} not found: run \`npm ci\` in the Odoo checkout of WEB`);
  }
  return require(path);
}
