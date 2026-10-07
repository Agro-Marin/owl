// The template files a compile check reads: under each root given as an
// argument, every `static/src` XML file outside node_modules (fs.glob); with
// no argument, the paths on stdin, one per line.
import fs from "node:fs";
import { join } from "node:path";

export async function templateFiles(roots = process.argv.slice(2)) {
  if (!roots.length) {
    return fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
  }
  const files = [];
  for (const root of roots) {
    for await (const file of fs.promises.glob("**/static/src/**/*.xml", {
      cwd: root,
      exclude: (path) => path.split("/").includes("node_modules"),
    })) {
      files.push(join(root, file));
    }
  }
  return files;
}
