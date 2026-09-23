const { JSDOM } = require(process.env.OWL + "/node_modules/jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
global.window = dom.window;
for (const k of Object.getOwnPropertyNames(dom.window)) { if (!(k in global)) { try { global[k] = dom.window[k]; } catch {} } }
const owl = require(process.env.OWL + "/dist/owl.cjs.js");
const fs = require("fs");
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
      const app = new owl.App(owl.Component, { test: true, warnIfNoStaticProps: false });
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
      if (!/Missing template|not defined|Cannot find/i.test(msg)) console.log("FAIL", file, name, "::", msg.slice(0, 160));
      else bad--;
    }
  }
}
console.log(`compiled ${total} templates, ${bad} failures`);
