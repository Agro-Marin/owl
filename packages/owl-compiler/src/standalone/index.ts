// -----------------------------------------------------------------------------
// This file exports a function that compiles templates ahead of time. It is
// built into dist/compile_templates.mjs, which tools/compile_owl_templates.mjs
// (`npm run compile_templates` in this repository) runs.
// -----------------------------------------------------------------------------

import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import "./setup_jsdom";
// Compiler imports must be made after setting up jsdom in the global namespace
import { compile, parseXML } from "..";

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
async function getXmlFiles(paths: string[]): Promise<string[]> {
  return (
    await Promise.all(
      paths.map(async (file) => {
        const stats = await stat(path.join(file));
        if (stats.isDirectory()) {
          return await getXmlFiles(
            (await readdir(file)).map((fileName) => path.join(file, fileName))
          );
        }
        if (file.endsWith(".xml")) {
          return file;
        }
        return [];
      })
    )
  ).flat();
}

// adapted from https://medium.com/@mhagemann/the-ultimate-way-to-slugify-a-url-string-in-javascript-b8e4a0d849e1
const a = "·-_,:;";
const p = new RegExp(a.split("").join("|"), "g");

function slugify(str: string) {
  return str
    .replace(/\//g, "") // remove /
    .replace(/\./g, "_") // Replace . with _
    .replace(p, (c) => "_") // Replace special characters
    .replace(/&/g, "_and_") // Replace & with ‘and’
    .replace(/[^\w\-]+/g, ""); // Remove all non-word characters
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

export async function compileTemplates(paths: string[]) {
  const files = await getXmlFiles(paths);
  process.stdout.write(`Processing ${files.length} files`);
  let xmlStrings = await Promise.all(files.map((file) => readFile(file, "utf8")));

  const templates = [];
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const fileName = files[i];
    const fileContent = xmlStrings[i];
    process.stdout.write(`.`);
    let doc: XMLDocument;
    try {
      doc = parseXML(fileContent);
    } catch (e) {
      errors.push({ name: null, fileName, e });
      continue;
    }
    for (const template of doc.querySelectorAll("[t-name]")) {
      const name = template.getAttribute("t-name")!;
      if (template.hasAttribute("owl")) {
        template.removeAttribute("owl");
      }
      const fnName = `template_${slugify(name)}`;
      try {
        // __globals__ among the helpers: the runtime always passes it
        const fn = compile(template, { name, hasGlobalValues: true })
          .toString()
          .replace("anonymous", fnName);
        templates.push(`${JSON.stringify(name)}: ${fn},\n`);
      } catch (e) {
        errors.push({ name, fileName, e });
      }
    }
  }
  process.stdout.write(`\n`);

  for (let { name, fileName, e } of errors) {
    console.warn(
      name === null
        ? `Error while parsing ${fileName}`
        : `Error while compiling '${name}' (in file ${fileName})`
    );
    console.error(e);
  }
  console.log(`${templates.length} templates compiled`);

  return `export const templates = {\n ${templates.join("\n")} \n}`;
}
