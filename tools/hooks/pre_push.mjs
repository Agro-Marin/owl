import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addOwlWorktree, removeWorktree } from "../worktree.mjs";
import { ROOT, scratchDir } from "../workspace.mjs";

const ZERO = /^0+$/;

// git feeds "<local ref> <local sha> <remote ref> <remote sha>" per pushed ref.
const commits = new Set();
for (const line of readFileSync(0, "utf8").split("\n")) {
  const [localRef, localSha] = line.trim().split(/\s+/);
  if (localRef && localSha && !ZERO.test(localSha)) {
    commits.add(localSha);
  }
}

let failed = false;
for (const commit of commits) {
  const tree = join(scratchDir("pre-push"), "tree");
  console.log(`[pre-push] npm run verify on ${commit.slice(0, 10)}, in ${tree}`);
  addOwlWorktree(ROOT, tree, commit);
  try {
    const run = spawnSync(process.execPath, ["tools/verify.mjs"], {
      cwd: tree,
      stdio: "inherit",
    });
    if (run.status !== 0) {
      failed = true;
      console.log(
        `[pre-push] ${commit.slice(0, 10)} fails verify: push refused (--no-verify skips)`
      );
    }
  } finally {
    removeWorktree(ROOT, tree);
    rmSync(join(tree, ".."), { recursive: true, force: true });
  }
}
process.exitCode = failed ? 1 : 0;
