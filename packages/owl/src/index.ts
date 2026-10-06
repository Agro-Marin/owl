import { TemplateSet } from "@odoo/owl-runtime";
import { compile, parseXML, Template, TemplateFunction } from "@odoo/owl-compiler";
import { buildHash, version } from "../../owl-runtime/src/build_info";
export type { Template, TemplateFunction };

export * from "@odoo/owl-runtime";

TemplateSet.compiler = { compile, parseXML, version, hash: buildHash };
