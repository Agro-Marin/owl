import fs from "node:fs";
import { installDom, oldBuild, owlBuild, requireFromOdoo, webAddon } from "./checker_env.mjs";
import customDirectives from "./custom_directives.mjs";
import { templateFiles, viewFiles } from "./template_files.mjs";
import { checkNodeVersion } from "../workspace.mjs";

checkNodeVersion();
const dom = installDom();
globalThis.odoo = { debug: "" };
const WEB = webAddon();
const xpath = requireFromOdoo(WEB, "xpath");
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

const { applyInheritance } = await import(WEB + "/static/src/core/template_inheritance.js");
const newBuild = owlBuild();
const previousBuild = oldBuild(WEB);
const newOwl = await import(newBuild);
const oldOwl = await import(previousBuild);
console.log(`owl build: ${newBuild}, compared with ${previousBuild}`);
if (process.env.OWL_DEBUG) {
  newOwl.setDebug(process.env.OWL_DEBUG);
  oldOwl.setDebug?.(process.env.OWL_DEBUG);
}

const config = {
  test: true,
  warnIfNoStaticProps: false,
  customDirectives,
  globalValues: { click() {} },
};

const base = new Map();
const primary = new Map();
const extensions = new Map();
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
const inputFiles = await templateFiles(undefined, { orViews: true });
const moduleDirs = new Map();
let xmlFailures = 0;
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
    console.log("XMLPARSE", file);
    xmlFailures++;
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
      extensions.getOrInsertComputed(parent, () => []).push({ el: t, file });
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
  let app;
  try {
    app = new owl.App(config);
    app.addTemplate(name, el.outerHTML);
    app.getTemplate(name);
    return null;
  } catch (e) {
    return String(e.message || e).split("\n")[0];
  } finally {
    app?.destroy();
  }
}

const JSDOM_ONLY = /Invalid attribute localName|Failed to serialize XML/;
let total = 0;
let bothFail = 0;
let unresolvedPrimary = 0;
let jsdomOnly = 0;
const regressions = [];
const fixedByNew = [];
for (const name of [...base.keys(), ...primary.keys()]) {
  const el = resolve(name);
  if (!el) {
    unresolvedPrimary++;
    if (process.env.UNAPPLIED) console.log("UNRESOLVED", name);
    continue;
  }
  total++;
  const fresh = compiles(newOwl, name, el);
  const stale = compiles(oldOwl, name, el);
  if (fresh && JSDOM_ONLY.test(fresh)) {
    jsdomOnly++;
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
const templateRegressions = regressions.length;
let archTotal = 0;
let archBothFail = 0;
let attributeSets = 0;
for (const file of await viewFiles(process.argv.slice(2))) {
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes("<templates") && !src.includes("attributes")) {
    continue;
  }
  const doc = new DOMParser().parseFromString(src, "text/xml");
  if (
    doc.getElementsByTagName("parsererror").length ||
    doc.documentElement.tagName === "templates"
  ) {
    continue;
  }
  for (const el of doc.querySelectorAll("templates [t-name]")) {
    const name = el.getAttribute("t-name");
    archTotal++;
    const fresh = compiles(newOwl, name, el);
    const stale = compiles(oldOwl, name, el);
    if (fresh && !stale && !JSDOM_ONLY.test(fresh)) {
      regressions.push(`${file} ${name} :: ${fresh.slice(0, 160)}`);
    } else if (fresh && stale) {
      archBothFail++;
    }
  }
  for (const target of doc.querySelectorAll('record [position="attributes"]')) {
    const expr = target.getAttribute("expr") || "";
    if (target.tagName !== "t" && !(target.tagName === "xpath" && /(^|\/)t(\[.*\])?$/.test(expr))) {
      continue;
    }
    attributeSets++;
    for (const attribute of target.querySelectorAll(":scope > attribute")) {
      const name = attribute.getAttribute("name") || "";
      if (name.startsWith("t-att")) {
        const record = target.closest("record").getAttribute("id");
        regressions.push(`${file} ${record} :: sets ${name} on a <t>, which the old build dropped`);
      }
    }
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
    `${templateRegressions} rejected only by the new build, ${fixedByNew.length} only by the old, ` +
    `${bothFail} by both; ${unapplied.length} extensions not applied (in module dependency order)`
);
console.log(
  `view archs: ${archTotal} templates, ${regressions.length - templateRegressions} rejected only by the new build ` +
    `(${archBothFail} by both), ` +
    `${attributeSets} inherited attribute sets on a <t>`
);
const absentExtensionTargets = [...extensions.keys()].filter(
  (name) => !base.has(name) && !primary.has(name)
);
console.log(
  `coverage: ${xmlFailures} XML parse failures, ${unresolvedPrimary} unresolved primary templates, ` +
    `${absentExtensionTargets.length} extension targets absent, ${jsdomOnly} JSDOM-only comparisons skipped`
);
if (regressions.length || xmlFailures) {
  process.exitCode = 1;
}

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
    let app;
    try {
      app = new newOwl.App(config);
      app.addTemplate(name, el.outerHTML);
      app.getTemplate(name);
      code = String(app.templates[name]);
    } catch {
      continue;
    } finally {
      app?.destroy();
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
