import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["owl", "owl-compiler", "owl-core", "owl-runtime"];

// node_modules entries resolve into the checkout they were linked from, except
// the workspace packages, which must resolve into the worktree's own sources.
export function linkNodeModules(tree, source) {
  mkdirSync(join(tree, "node_modules"), { recursive: true });
  for (const entry of readdirSync(join(source, "node_modules"))) {
    if (entry !== "@odoo") {
      symlinkSync(join(source, "node_modules", entry), join(tree, "node_modules", entry));
    }
  }
  mkdirSync(join(tree, "node_modules/@odoo"));
  for (const name of PACKAGES) {
    symlinkSync(join("../../packages", name), join(tree, "node_modules/@odoo", name));
  }
}

export function addOwlWorktree(root, tree, commit) {
  execFileSync("git", ["worktree", "add", "--detach", tree, commit], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  linkNodeModules(tree, root);
}

export function removeWorktree(root, tree) {
  execFileSync("git", ["worktree", "remove", "--force", tree], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
}
