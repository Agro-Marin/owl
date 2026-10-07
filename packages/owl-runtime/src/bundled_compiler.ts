import type { TemplateCompiler } from "./template_set";

// The compiler a build carries: none in the runtime build. The full build
// (packages/owl/build.mjs, and its tests) resolves this module to
// packages/owl/src/bundled_compiler.ts, so that installing its compiler is a
// value, not a statement run on import: a bundle that keeps no TemplateSet
// drops the compiler.
export const bundledCompiler: TemplateCompiler | null = null;
