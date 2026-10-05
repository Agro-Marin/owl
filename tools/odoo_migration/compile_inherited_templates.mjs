// Compiles every Odoo template after applying its inheritance (Odoo's own
// web/static/src/core/template_inheritance.js), with two owl builds, and
// reports the templates the new build rejects and the old one accepted.
// compile_templates.cjs compiles template files as written: a directive an
// inheriting template adds (a t-if on a t-else node) is invisible to it.
//
//   find <repos> -path '*/static/src/*' -name '*.xml' ... | \
//     OWL=<owl checkout> OLD=<old owl.es.js> WEB=<odoo>/addons/web \
//     node compile_inherited_templates.mjs
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.OWL + "/node_modules/jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (!(k in globalThis)) {
    try {
      globalThis[k] = dom.window[k];
    } catch {}
  }
}
globalThis.odoo = { debug: "" };

const { applyInheritance } = await import(
  process.env.WEB + "/static/src/core/template_inheritance.js"
);
const newOwl = await import(process.env.OWL + "/packages/owl/dist/owl.es.js");
const oldOwl = await import(process.env.OLD);

const customDirectives = {
  click: (node, value, modifiers) => {
    const mods = ["synthetic", "capture"]
      .filter((m) => modifiers.includes(m))
      .map((m) => "." + m)
      .join("");
    const handler = `(ev) => __globals__.click(ev, (${value}).bind(this))`;
    node.setAttribute(`t-on-click${mods}`, handler);
    node.setAttribute(`t-on-auxclick${mods}`, handler);
  },
  ref: (node, value) => {
    node.setAttribute("t-ref", `__globals__.createRefSignal(this, "${value}")`);
  },
  model: (node, value, modifiers) => {
    node.setAttribute(
      ["t-model", ...modifiers].join("."),
      `__globals__.createModelSignal(() => ${value}, (nv) => {${value} = nv;})`
    );
  },
  portal: (node, value) => {
    node.setAttribute("t-component", "__globals__.Portal");
    node.setAttribute("selector", value);
  },
};
const config = {
  test: true,
  warnIfNoStaticProps: false,
  customDirectives,
  globalValues: { click() {} },
};

const base = new Map();
const primary = new Map();
const extensions = new Map();
for (const file of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) {
  const doc = new DOMParser().parseFromString(fs.readFileSync(file, "utf8"), "text/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    continue;
  }
  for (const t of doc.querySelectorAll("[t-name], [t-inherit]")) {
    if (t.parentNode?.closest?.("[t-name], [t-inherit]")) {
      continue;
    }
    const parent = t.getAttribute("t-inherit");
    const name = t.getAttribute("t-name");
    if (!parent) {
      base.set(name, { el: t, file });
    } else if (t.getAttribute("t-inherit-mode") === "extension") {
      if (!extensions.has(parent)) {
        extensions.set(parent, []);
      }
      extensions.get(parent).push({ el: t, file });
    } else if (name) {
      primary.set(name, { el: t, parent, file });
    }
  }
}

const unapplied = [];
const resolved = new Map();
function extend(name, el) {
  for (const ext of extensions.get(name) || []) {
    try {
      el = applyInheritance(el.cloneNode(true), ext.el.cloneNode(true), ext.file);
    } catch (e) {
      unapplied.push(`${ext.file} -> ${name}: ${String(e.message).split("\n")[0].slice(0, 120)}`);
    }
  }
  return el;
}
function resolve(name, chain = new Set()) {
  if (resolved.has(name)) {
    return resolved.get(name);
  }
  let el = null;
  if (base.has(name)) {
    el = extend(name, base.get(name).el.cloneNode(true));
  } else if (primary.has(name) && !chain.has(name)) {
    const { el: own, parent, file } = primary.get(name);
    const parentEl = resolve(parent, new Set([...chain, name]));
    if (parentEl) {
      try {
        let built = applyInheritance(parentEl.cloneNode(true), own.cloneNode(true), file);
        if (built.tagName !== own.tagName) {
          const temp = built;
          built = document.createElement(own.tagName);
          built.append(...temp.childNodes);
        }
        for (const { name: attr, value } of own.attributes) {
          if (!["t-inherit", "t-inherit-mode"].includes(attr)) {
            built.setAttribute(attr, value);
          }
        }
        el = extend(name, built);
      } catch (e) {
        unapplied.push(`${file} -> ${parent}: ${String(e.message).split("\n")[0].slice(0, 120)}`);
      }
    }
  }
  resolved.set(name, el);
  return el;
}

function compiles(owl, name, el) {
  try {
    const app = new owl.App(config);
    app.addTemplate(name, el.outerHTML);
    app.getTemplate(name);
    return null;
  } catch (e) {
    return String(e.message || e).split("\n")[0];
  }
}

const JSDOM_ONLY = /Invalid attribute localName|Failed to serialize XML/;
let total = 0;
let bothFail = 0;
const regressions = [];
const fixedByNew = [];
for (const name of [...base.keys(), ...primary.keys()]) {
  const el = resolve(name);
  if (!el) {
    continue;
  }
  total++;
  const fresh = compiles(newOwl, name, el);
  const stale = compiles(oldOwl, name, el);
  if (fresh && JSDOM_ONLY.test(fresh)) {
    continue;
  }
  if (fresh && !stale) {
    regressions.push(`${name} :: ${fresh.slice(0, 160)}`);
  } else if (!fresh && stale) {
    fixedByNew.push(`${name} :: ${stale.slice(0, 120)}`);
  } else if (fresh && stale) {
    bothFail++;
    console.log("BOTH", `${name} :: ${fresh.slice(0, 160)}`);
  }
}
for (const line of regressions) {
  console.log("REGRESSION", line);
}
for (const line of fixedByNew) {
  console.log("NEW-ONLY-OK", line);
}
if (process.env.UNAPPLIED) {
  for (const line of unapplied) {
    console.log("UNAPPLIED", line);
  }
}
console.log(
  `${total} templates after inheritance (${extensions.size} extended, ${primary.size} primary); ` +
    `${regressions.length} rejected only by the new build, ${fixedByNew.length} only by the old, ` +
    `${bothFail} by both; ${unapplied.length} extensions not applied (order across modules approximated)`
);
