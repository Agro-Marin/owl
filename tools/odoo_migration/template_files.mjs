import fs from "node:fs";
import { join } from "node:path";

function refuse(message) {
  console.error(message);
  process.exit(2);
}

const nothing = (orViews) =>
  `no template file (**/static/src/**/*.xml)${orViews ? " and no view file" : ""}`;

export async function templateFiles(roots = process.argv.slice(2), { orViews = false } = {}) {
  if (!roots.length) {
    if (process.stdin.isTTY) {
      refuse("usage: <checker> <module roots...>, or the template files' paths on stdin");
    }
    const files = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
    if (!files.length) {
      refuse("no template file on stdin");
    }
    return files;
  }
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      refuse(`${root} does not exist`);
    }
    const before = files.length;
    for await (const file of fs.promises.glob("**/static/src/**/*.xml", {
      cwd: root,
      exclude: (path) => path.split("/").includes("node_modules"),
    })) {
      files.push(join(root, file));
    }
    if (files.length === before && !(orViews && (await viewFiles([root])).length)) {
      console.error(`skipped ${root}: ${nothing(orViews)}`);
    }
  }
  if (!files.length && !(orViews && (await viewFiles(roots)).length)) {
    refuse(`nothing to check: every root holds ${nothing(orViews)}`);
  }
  return files;
}

export async function viewFiles(roots) {
  const files = [];
  for (const root of roots) {
    for await (const file of fs.promises.glob("**/*.xml", {
      cwd: root,
      exclude: (path) => {
        const parts = path.split("/");
        return parts.includes("node_modules") || parts.includes("static");
      },
    })) {
      files.push(join(root, file));
    }
  }
  return files;
}
