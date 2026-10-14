import { compile, parseXML } from "@odoo/owl-compiler";
import type { TemplateCompiler } from "@odoo/owl-runtime";
import { buildHash, version } from "../../owl-runtime/src/build_info";

export const bundledCompiler: TemplateCompiler | null = {
  compile,
  parseXML,
  version,
  hash: buildHash,
};
