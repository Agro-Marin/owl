import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..");

interface MarkDownLink {
  name: string;
  link: string;
}

interface MarkDownSection {
  name: string;
  slug: string;
}

interface FileData {
  name: string;
  path: string[];
  fullName: string;
  links: MarkDownLink[];
  sections: MarkDownSection[];
}

const LINK_REGEXP = /\[([^\[]+)\]\(([^\)]+)\)/g;
const HEADING_REGEXP = /\n(#+\s*)(.*)/g;

export function addMarkdownData(fileData: FileData): void {
  const sep = fileData.path.length > 0 ? "/" : "";
  const fullName = fileData.path.join("/") + sep + fileData.name;
  const content = fs.readFileSync(path.join(REPO_ROOT, fullName), { encoding: "utf8" });
  let m;
  do {
    m = LINK_REGEXP.exec(content);
    if (m) {
      fileData.links.push({ name: m[0], link: m[2] });
    }
  } while (m);
  do {
    m = HEADING_REGEXP.exec(content);
    if (m) {
      fileData.sections.push({ name: m[0], slug: slugify(m[2]) });
    }
  } while (m);
}

function getFiles(filePath: string[] = []): FileData[] {
  if (filePath.length === 0) {
    const baseFiles: FileData[] = [
      { name: "README.md", path: [], links: [], sections: [], fullName: "README.md" },
    ];
    const rest = getFiles(["doc"]);
    const result = baseFiles.concat(rest);
    result.forEach(addMarkdownData);
    return result;
  }
  const absPath = path.join(REPO_ROOT, filePath.join("/"));
  const files = fs.readdirSync(absPath, { withFileTypes: true }).map((f) => {
    if (f.name.startsWith(".")) {
      return [];
    }
    if (f.isDirectory()) {
      return getFiles(filePath.concat(f.name));
    }
    const fullName = filePath.join("/") + (filePath.length > 0 ? "/" : "") + f.name;
    return [
      {
        name: f.name,
        path: filePath,
        links: [],
        sections: [],
        fullName,
      },
    ];
  });
  return Array.prototype.concat(...files);
}

const LOCAL_FILES = ["LICENSE"];
const SKIP_LINK_CHECK: string[] = [];
export function isLinkValid(link: MarkDownLink, current: FileData, files: FileData[]): boolean {
  if (link.link.startsWith("http")) {
    return true;
  }
  if (link.link.startsWith("../")) {
    return true;
  }
  if (SKIP_LINK_CHECK.includes(current.name)) {
    return true;
  }
  if (current.name.endsWith(".png")) {
    return true;
  }

  const parts = link.link.split("#");
  const hash = parts[1] || "";
  let name;
  let linkPath;
  if (parts[0]) {
    let temp = parts[0].split("/");
    name = temp[temp.length - 1];
    temp.splice(-1);
    linkPath = current.path.slice();
    for (let elem of temp) {
      if (elem === "..") {
        linkPath.splice(-1);
      } else if (elem !== ".") {
        linkPath.push(elem);
      }
    }
  } else {
    name = current.name;
    linkPath = current.path;
  }

  const linkFullName = linkPath.join("/") + (linkPath.length > 0 ? "/" : "") + name;

  if (LOCAL_FILES.includes(linkFullName)) {
    return true;
  }

  let target: FileData | undefined = files.find((f) => f.fullName === linkFullName);
  if (!target) {
    return false;
  }

  if (hash) {
    if (!target.sections.find((s) => s.slug === hash)) {
      return false;
    }
  }

  return true;
}

function slugify(str: string): string {
  const a = "àáäâãåăæçèéëêǵḧìíïîḿńǹñòóöôœøṕŕßśșțùúüûǘẃẍÿź·_,:;";
  const b = "aaaaaaaaceeeeghiiiimnnnooooooprssstuuuuuwxyz-----";
  const p = new RegExp(a.split("").join("|"), "g");
  return str
    .toString()
    .toLowerCase()
    .replace(/\//g, "")
    .replace(/\s+/g, "-")
    .replace(p, (c) => b.charAt(a.indexOf(c)))
    .replace(/&/g, "-and-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

test("All markdown links work", () => {
  let linkNumber = 0;
  let invalidLinkNumber = 0;
  const data = getFiles();
  for (let file of data) {
    for (let link of file.links) {
      linkNumber++;
      if (!isLinkValid(link, file, data)) {
        console.warn(`Invalid Link: "${link.name}" in "${file.name}"`);
        invalidLinkNumber++;
      }
    }
  }
  expect(invalidLinkNumber).toBe(0);
  expect(linkNumber).toBeGreaterThan(10);
});
