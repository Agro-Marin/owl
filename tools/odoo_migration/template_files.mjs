import fs from "node:fs";
import { join } from "node:path";

export async function templateFiles(roots = process.argv.slice(2)) {
  if (!roots.length) {
    if (process.stdin.isTTY) {
      console.error("usage: <checker> <module roots...>, or the template files' paths on stdin");
      process.exit(2);
    }
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
