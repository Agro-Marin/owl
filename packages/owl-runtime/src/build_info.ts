import type {} from "./build-env";
import { version } from "./version";
export { version };
export const buildHash: string = __BUILD_HASH__;
export const build: string = /* @__PURE__ */ buildName(version, buildHash);

function buildName(version: string, hash: string): string {
  return `${version}+${hash}`;
}
