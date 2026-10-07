// Compiles every Odoo template file as written with one owl build: the files
// under the roots given as arguments, or listed on stdin (template_files.mjs).
//
//   OWL=<owl checkout> node compile_templates.mjs <repo> ...
import fs from "node:fs";
import { createRequire } from "node:module";
import customDirectives from "./custom_directives.mjs";
import { templateFiles } from "./template_files.mjs";

const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.OWL + "/node_modules/jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
for (const k of Object.getOwnPropertyNames(dom.window)) { if (!(k in globalThis)) { try { globalThis[k] = dom.window[k]; } catch {} } }
// a 3.0 monorepo checkout builds packages/owl/dist/owl.es.js, a 2.8 one dist/owl.es.js
const build = ["/packages/owl/dist/owl.es.js", "/dist/owl.es.js"]
  .map((path) => process.env.OWL + path)
  .find((path) => fs.existsSync(path));
const owl = await import(build);
const isOwl3 = build.endsWith("/packages/owl/dist/owl.es.js");
console.log(`owl build: ${build}`);
const config = { test: true, warnIfNoStaticProps: false, customDirectives, globalValues: { click() {} } };
// jsdom refuses a prefixed attribute (xmlns:xlink) a browser accepts: such a
// template is reported apart, not counted as a failure
const JSDOM_ONLY = /Invalid attribute localName|Failed to serialize XML/;
const files = await templateFiles();
let total = 0, bad = 0;
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const doc = new DOMParser().parseFromString(src, "text/xml");
  if (doc.getElementsByTagName("parsererror").length) { console.log("XMLPARSE", file); bad++; continue; }
  for (const t of doc.querySelectorAll("[t-name]")) {
    if (t.hasAttribute("t-inherit")) continue;
    if (t.parentNode && t.parentNode.closest && t.parentNode.closest("[t-name]")) continue;
    total++;
    const name = t.getAttribute("t-name");
    try {
      const app = isOwl3 ? new owl.App(config) : new owl.App(owl.Component, config);
      const ts = app;
      ts.addTemplate(name, t.outerHTML);
      ts.getTemplate(name);
    } catch (e) {
      bad++;
      const full = String(e.message || e);
      const msg = full.split("\n")[0];
      if (process.env.LOCATE && /missing \)|Unexpected|Invalid or unexpected/.test(full)) {
        const code = full.slice(full.indexOf("function("));
        try { require(process.env.OWL + "/node_modules/acorn").parse("(" + code + ")", { ecmaVersion: 2022 }); }
        catch (pe) { const lines = ("(" + code + ")").split("\n"); console.log("  AT", pe.loc && pe.loc.line, "::", (lines[(pe.loc && pe.loc.line || 1) - 1] || "").trim().slice(0, 220)); }
      }
      if (JSDOM_ONLY.test(msg)) { console.log("JSDOM", file, name, "::", msg.slice(0, 160)); bad--; }
      else if (!/Missing template|not defined|Cannot find/i.test(msg)) console.log("FAIL", file, name, "::", msg.slice(0, 160));
      else bad--;
    }
  }
}
console.log(`compiled ${total} templates, ${bad} failures`);
