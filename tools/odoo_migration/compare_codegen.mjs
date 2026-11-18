import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { installDom, owlBuild, webAddon } from "./checker_env.mjs";
import customDirectives from "./custom_directives.mjs";
import { templateFiles } from "./template_files.mjs";
import { checkNodeVersion } from "../workspace.mjs";

checkNodeVersion();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    old: { type: "string" },
    new: { type: "string" },
    show: { type: "string", default: "10" },
  },
});
installDom();

const newPath = resolve(values.new ?? join(dirname(owlBuild()), "owl.compiler.es.js"));
const oldPath = resolve(values.old ?? join(webAddon(), "static/lib/owl/owl.compiler.es.js"));
for (const path of [oldPath, newPath]) {
  if (!fs.existsSync(path)) {
    console.error(`${path} not found: --old and --new name a module exporting compile()`);
    process.exit(2);
  }
}
const [oldCompiler, newCompiler] = [await import(oldPath), await import(newPath)];
console.log(`old compiler: ${oldPath}\nnew compiler: ${newPath}`);

const INLINE_RE = /\bxml\s*`((?:[^`\\$]|\\.|\$(?!\{))*)`/g;

async function inlineFiles(roots) {
  const files = [];
  for (const root of roots) {
    for await (const file of fs.promises.glob("**/static/{src,tests}/**/*.js", {
      cwd: root,
      exclude: (path) => {
        const parts = path.split("/");
        return parts.includes("node_modules") || parts.includes("lib");
      },
    })) {
      files.push(join(root, file));
    }
  }
  return files;
}

function* staticTemplates(files) {
  for (const file of files) {
    const doc = new DOMParser().parseFromString(fs.readFileSync(file, "utf8"), "text/xml");
    if (doc.getElementsByTagName("parsererror").length) {
      continue;
    }
    for (const template of doc.querySelectorAll("[t-name]")) {
      if (template.hasAttribute("t-inherit") || template.parentNode?.closest?.("[t-name]")) {
        continue;
      }
      yield { where: file, name: template.getAttribute("t-name"), source: template.outerHTML };
    }
  }
}

function* inlineTemplates(files) {
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("xml`")) {
      continue;
    }
    let index = 0;
    for (const match of text.matchAll(INLINE_RE)) {
      index++;
      yield {
        where: file,
        name: `xml#${index}`,
        source: match[1].replace(/\\`/g, "`").replace(/\\\\/g, "\\"),
      };
    }
  }
}

function compileWith(compiler, template) {
  try {
    return {
      code: compiler
        .compile(template.source, { name: template.name, customDirectives, hasGlobalValues: true })
        .toString(),
    };
  } catch (error) {
    return { error: String(error.message ?? error).split("\n")[0] };
  }
}

function firstDifference(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return `line ${i + 1}:\n    old ${JSON.stringify(left[i])}\n    new ${JSON.stringify(right[i])}`;
    }
  }
  return "";
}

const roots = positionals;
const staticList = await templateFiles(roots);
const inlineList = roots.length ? await inlineFiles(roots) : [];
const counts = { static: 0, inline: 0, same: 0, differ: 0, bothFail: 0, oldOnlyFail: 0 };
const problems = [];
for (const [kind, templates] of [
  ["static", staticTemplates(staticList)],
  ["inline", inlineTemplates(inlineList)],
]) {
  for (const template of templates) {
    counts[kind]++;
    const before = compileWith(oldCompiler, template);
    const after = compileWith(newCompiler, template);
    if (before.error && after.error) {
      counts.bothFail++;
    } else if (before.error) {
      counts.oldOnlyFail++;
    } else if (after.error) {
      problems.push(`NEW-ONLY FAILURE ${template.where} ${template.name}: ${after.error}`);
    } else if (before.code === after.code) {
      counts.same++;
    } else {
      counts.differ++;
      problems.push(
        `DIFFERS ${template.where} ${template.name}, ${firstDifference(before.code, after.code)}`
      );
    }
  }
}
for (const problem of problems.slice(0, Number(values.show))) {
  console.log(problem);
}
if (problems.length > Number(values.show)) {
  console.log(`... ${problems.length - Number(values.show)} more (--show N)`);
}
console.log(
  `${counts.static} static and ${counts.inline} inline templates: ${counts.same} identical, ` +
    `${counts.differ} differ, ${problems.length - counts.differ} rejected only by the new compiler, ` +
    `${counts.oldOnlyFail} only by the old, ${counts.bothFail} by both`
);
if (problems.length) {
  process.exitCode = 1;
}
