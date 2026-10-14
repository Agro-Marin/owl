import type {} from "./build-env";
import { version } from "./version";
export { version };
export const buildHash: string = __BUILD_HASH__;
export const build: string = buildName(version, buildHash);

function buildName(version: string, hash: string): string {
  return `${version}+${hash}`;
}
