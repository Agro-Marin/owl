import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../workspace.mjs";
import { pushedCommits } from "./pre_push.mjs";

test("a push is verified once per commit: a tag as the commit it names, a deletion not", () => {
  const root = scratchDir("owl-pre-push-test");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  try {
    git("init", "-q");
    writeFileSync(join(root, "a"), "a");
    git("add", "a");
    git("commit", "-q", "-m", "a");
    git("tag", "-a", "v1", "-m", "v1");
    const commit = git("rev-parse", "HEAD");
    const tag = git("rev-parse", "v1");
    expect(tag).not.toBe(commit);
    const zero = "0".repeat(40);
    const input = [
      `refs/heads/main ${commit} refs/heads/main ${zero}`,
      `refs/tags/v1 ${tag} refs/tags/v1 ${zero}`,
      `(delete) ${zero} refs/heads/old ${commit}`,
      "",
    ].join("\n");
    expect(pushedCommits(input, root)).toEqual([commit]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
