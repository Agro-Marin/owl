/// <reference path="./build-env.d.ts" />
// The build this code is part of. The compiler module (@odoo/owl/compiler)
// compiles for the helpers of one build: the runtime checks that it is its own.
import { version } from "./version";
export { version };
export const buildHash: string = __BUILD_HASH__;
// "<version>+<hash>", the key a compiler module registers under
export const build: string = /* @__PURE__ */ buildName(version, buildHash);

function buildName(version: string, hash: string): string {
  return `${version}+${hash}`;
}
