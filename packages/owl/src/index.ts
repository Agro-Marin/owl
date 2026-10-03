import { TemplateSet } from "@odoo/owl-runtime";
import { compile, parseXML, Template, TemplateFunction } from "@odoo/owl-compiler";
export type { Template, TemplateFunction };

export * from "@odoo/owl-runtime";

TemplateSet.compiler = { compile, parseXML };
