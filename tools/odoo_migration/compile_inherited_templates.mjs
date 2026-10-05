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
// jsdom's XPath engine departs from the browser's (as Odoo's own precompiler,
// odoo/tools/assets/js/owl_precompile.mjs, notes): evaluate the extensions'
// xpaths with the `xpath` package, as that precompiler does
const xpath = require(process.env.WEB + "/../../node_modules/xpath");
dom.window.Document.prototype.createExpression = function createExpression(expression) {
  const parsed = xpath.parse(expression);
  return {
    evaluate(context) {
      const nodes = parsed.select({ node: context });
      if (!Array.isArray(nodes)) {
        throw new dom.window.TypeError("The result is not a node set");
      }
      return { snapshotLength: nodes.length, snapshotItem: (i) => nodes[i] ?? null };
    },
  };
};

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
// Odoo applies a template's extensions in module load order: a module after
// the modules it depends on. Files are visited by their module's rank in a
// dependency-first order (from each __manifest__.py's `depends`), then path.
function moduleOf(file) {
  const at = file.indexOf("/static/");
  return at < 0 ? null : file.slice(0, at);
}
function dependsOf(moduleDir) {
  try {
    const manifest = fs.readFileSync(moduleDir + "/__manifest__.py", "utf8");
    const list = /["']depends["']\s*:\s*\[([^\]]*)\]/.exec(manifest);
    return list ? [...list[1].matchAll(/["']([\w.]+)["']/g)].map((m) => m[1]) : [];
  } catch {
    return [];
  }
}
const inputFiles = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
const moduleDirs = new Map();
for (const file of inputFiles) {
  const dir = moduleOf(file);
  if (dir) {
    moduleDirs.set(dir.split("/").pop(), dir);
  }
}
const rank = new Map();
function visit(name, stack = new Set()) {
  if (rank.has(name) || stack.has(name) || !moduleDirs.has(name)) {
    return;
  }
  stack.add(name);
  for (const dep of dependsOf(moduleDirs.get(name)).sort()) {
    visit(dep, stack);
  }
  rank.set(name, rank.size);
}
for (const name of [...moduleDirs.keys()].sort()) {
  visit(name);
}
const rankOf = (file) => rank.get(moduleOf(file)?.split("/").pop()) ?? -1;
inputFiles.sort((a, b) => rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0));

for (const file of inputFiles) {
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
    `${bothFail} by both; ${unapplied.length} extensions not applied (in module dependency order)`
);

// FREE_NAMES=1: a component's own template reads a context name nothing in it
// sets — not `this.x`, not a t-set, t-as, slot scope or arrow parameter — so
// it is undefined at run time (a template a t-call names is skipped: its
// caller provides its names). Component templates are the names some
// module's JavaScript gives as `static template = "..."`.
if (process.env.FREE_NAMES) {
  const componentTemplates = new Set();
  const moduleRoots = new Set([...moduleDirs.values()]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "lib" && entry.name !== "tests") {
          walk(path);
        }
      } else if (entry.name.endsWith(".js")) {
        for (const m of fs.readFileSync(path, "utf8").matchAll(/static template = "([^"]+)"/g)) {
          componentTemplates.add(m[1]);
        }
      }
    }
  };
  for (const root of moduleRoots) {
    if (fs.existsSync(root + "/static/src")) {
      walk(root + "/static/src");
    }
  }
  const called = new Set();
  const allTemplates = [...base.values(), ...primary.values(), ...[...extensions.values()].flat()];
  for (const { el } of allTemplates) {
    for (const node of el.querySelectorAll("[t-call]")) {
      called.add(node.getAttribute("t-call"));
    }
  }
  const findings = [];
  for (const name of componentTemplates) {
    const el = resolve(name);
    if (!el || called.has(name)) {
      continue;
    }
    let code;
    try {
      const app = new newOwl.App(config);
      app.addTemplate(name, el.outerHTML);
      app.getTemplate(name);
      code = String(app.templates[name]);
    } catch {
      continue;
    }
    const reads = new Set([...code.matchAll(/ctx\['([\w$]+)'\]/g)].map((m) => m[1]));
    const sets = new Set([...code.matchAll(/ctx\[["`']([\w$]+)["`']\]\s*=/g)].map((m) => m[1]));
    for (const m of code.matchAll(/\(([\w$, ]+)\)\s*=>/g)) {
      for (const param of m[1].split(",")) {
        sets.add(param.trim());
      }
    }
    const free = [...reads].filter((r) => !sets.has(r) && r !== "this" && r !== "__globals__");
    if (free.length) {
      findings.push(`${name} :: ${free.join(", ")}`);
    }
  }
  for (const line of findings) {
    console.log("FREE-NAME", line);
  }
  console.log(
    `${componentTemplates.size} component templates; ${findings.length} read a name nothing sets`
  );
}
