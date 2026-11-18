import { execFileSync } from "child_process";
import { copyFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { scratchDir } from "../../../tools/workspace.mjs";

export const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");

// A build of the package (and of its declarations) takes seconds on an idle
// machine and over a minute on a loaded one, where the pre-push hook runs.
export const BUILD_TIMEOUT = 300_000;

export function scratchPackage(prefix: string, { types = false } = {}): string {
  const root = scratchDir(prefix);
  copyFileSync(join(PACKAGE, "package.json"), join(root, "package.json"));
  const build = (...args: string[]) =>
    execFileSync(process.execPath, ["build.mjs", ...args, "--outdir", join(root, "dist")], {
      cwd: PACKAGE,
      stdio: "pipe",
    });
  build();
  if (types) {
    build("types");
  }
  return root;
}

export function removeScratchPackage(root: string | undefined): void {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
}
