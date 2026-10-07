// The full build: the runtime, its own compiler bundled (src/bundled_compiler.ts,
// which the build puts in place of owl-runtime's empty one).
import type { Template, TemplateFunction } from "@odoo/owl-compiler";
export type { Template, TemplateFunction };

export * from "@odoo/owl-runtime";
