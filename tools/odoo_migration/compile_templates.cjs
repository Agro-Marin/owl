const { JSDOM } = require(process.env.OWL + "/node_modules/jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
global.window = dom.window;
for (const k of Object.getOwnPropertyNames(dom.window)) { if (!(k in global)) { try { global[k] = dom.window[k]; } catch {} } }
const fs = require("fs");
// a 3.0 monorepo checkout builds packages/owl/dist/owl.cjs, a 2.8 one dist/owl.cjs.js
const build = ["/packages/owl/dist/owl.cjs", "/dist/owl.cjs.js"]
  .map((path) => process.env.OWL + path)
  .find((path) => fs.existsSync(path));
const owl = require(build);
const isOwl3 = build.endsWith("/packages/owl/dist/owl.cjs");
console.log(`owl build: ${build}`);
// Odoo's custom directives (web/static/src/env.js, spreadsheet's
// o_spreadsheet.js): a template using t-custom-* compiles only with them
const customDirectives = {
  click: (node, value, modifiers) => {
    const mods = ["synthetic", "capture"].filter((m) => modifiers.includes(m)).map((m) => "." + m).join("");
    const handler = `(ev) => __globals__.click(ev, (${value}).bind(this))`;
    node.setAttribute(`t-on-click${mods}`, handler);
    node.setAttribute(`t-on-auxclick${mods}`, handler);
  },
  ref: (node, value) => {
    const refName = `"` + value.replaceAll(/\{\{(.+?)\}\}/g, `" + $1 + "`) + `"`;
    node.setAttribute("t-ref", `__globals__.createRefSignal(this, ${refName})`);
  },
  model: (node, value, modifiers) => {
    const attribute = ["t-model", ...modifiers].join(".");
    node.setAttribute(attribute, `__globals__.createModelSignal(() => ${value}, (nv) => {${value} = nv;})`);
  },
  portal: (node, value) => {
    node.setAttribute("t-component", "__globals__.Portal");
    node.setAttribute("selector", value);
  },
};
const config = { test: true, warnIfNoStaticProps: false, customDirectives, globalValues: { click() {} } };
// jsdom refuses a prefixed attribute (xmlns:xlink) a browser accepts: such a
// template is reported apart, not counted as a failure
const JSDOM_ONLY = /Invalid attribute localName|Failed to serialize XML/;
const files = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
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
