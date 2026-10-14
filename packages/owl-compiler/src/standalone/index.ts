// -----------------------------------------------------------------------------
// This file exports a function that compiles templates ahead of time:
// tools/compile_owl_templates.mjs (`npm run compile_templates` in this
// repository) runs it with Node, from its TypeScript source.
// -----------------------------------------------------------------------------

import { readdir, readFile, realpath, stat } from "fs/promises";
import path from "path";
import { debuglog } from "node:util";
import "./setup_jsdom";
// Compiler imports must be made after setting up jsdom in the global namespace
import { compile, parseXML } from "..";

const log = debuglog("owl-compile");

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
async function getXmlFiles(paths: string[]): Promise<string[]> {
  const directories = new Set<string>();
  const files = new Set<string>();
  async function visit(file: string): Promise<void> {
    const canonical = await realpath(file);
    const stats = await stat(canonical);
    if (stats.isDirectory()) {
      if (directories.has(canonical)) {
        log("skip visited directory %s", canonical);
        return;
      }
      directories.add(canonical);
      for (const name of (await readdir(canonical)).sort()) {
        await visit(path.join(canonical, name));
      }
    } else if (file.endsWith(".xml")) {
      files.add(canonical);
    }
  }
  for (const file of paths) {
    await visit(file);
  }
  return [...files].sort();
}

function templateFunctionName(name: string): string {
  return `template_${name.replace(/[^\w$]/g, "_")}`;
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

export async function compileTemplates(paths: string[]) {
  log("discover templates under %d input path(s)", paths.length);
  const files = await getXmlFiles(paths);
  process.stdout.write(`Processing ${files.length} files`);

  const templates = [];
  const errors: Error[] = [];
  const names = new Map<string, string>();

  for (const fileName of files) {
    log("read %s", fileName);
    const fileContent = await readFile(fileName, "utf8");
    process.stdout.write(`.`);
    let doc: XMLDocument;
    try {
      doc = parseXML(fileContent);
    } catch (e) {
      log("parse failed: %s", fileName);
      errors.push(new Error(`Error while parsing ${fileName}`, { cause: e }));
      continue;
    }
    for (const template of doc.querySelectorAll("[t-name]")) {
      const name = template.getAttribute("t-name")!;
      if (template.hasAttribute("owl")) {
        template.removeAttribute("owl");
      }
      const fnName = templateFunctionName(name);
      try {
        if (names.has(name)) {
          throw new Error(`Duplicate template '${name}'; first declared in ${names.get(name)}`);
        }
        names.set(name, fileName);
        log("compile %s in %s", name, fileName);
        // __globals__ among the helpers: the runtime always passes it
        const fn = compile(template, { name, hasGlobalValues: true })
          .toString()
          .replace("anonymous", fnName);
        // Computed keys keep '__proto__' as an own entry rather than setting
        // the generated object's prototype.
        templates.push(`[${JSON.stringify(name)}]: ${fn},\n`);
      } catch (e) {
        log("compile failed: %s in %s", name, fileName);
        errors.push(
          new Error(`Error while compiling '${name}' (in file ${fileName})`, { cause: e })
        );
      }
    }
  }
  process.stdout.write(`\n`);

  if (errors.length) {
    log("reject compilation: %d error(s), %d valid template(s)", errors.length, templates.length);
    throw new AggregateError(errors, `Template compilation failed with ${errors.length} error(s)`);
  }
  console.log(`${templates.length} templates compiled`);

  return `export const templates = {\n ${templates.join("\n")} \n}`;
}
