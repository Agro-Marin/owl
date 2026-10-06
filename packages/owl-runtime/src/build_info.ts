/// <reference path="./build-env.d.ts" />
// The build this code is part of. The compiler module (@odoo/owl/compiler)
// compiles for the helpers of one build: the runtime checks that it is its own.
export { version } from "./version";
export const buildHash: string = __BUILD_HASH__;
