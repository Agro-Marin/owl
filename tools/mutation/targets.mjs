import { join } from "node:path";
import { ROOT } from "../workspace.mjs";

export const PACKAGES = {
  "owl-core": {
    dir: "packages/owl-core",
    project: null,
    files: ["packages/owl-core/src/computations.ts", "packages/owl-core/src/proxy.ts"],
  },
  "owl-runtime": {
    dir: "packages/owl-runtime",
    project: "dom",
    files: [
      "packages/owl-runtime/src/rendering/fibers.ts",
      "packages/owl-runtime/src/rendering/scheduler.ts",
    ],
  },
};

export const REPORTS = join(ROOT, "temp/mutation");

export function packageOf(file) {
  const name = Object.keys(PACKAGES).find((pkg) => PACKAGES[pkg].files.includes(file));
  if (!name) {
    const known = Object.values(PACKAGES).flatMap((pkg) => pkg.files);
    throw new Error(`${file} is not a mutation target (targets: ${known.join(", ")})`);
  }
  return name;
}
