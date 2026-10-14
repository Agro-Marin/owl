import { compile, parseXML } from "@odoo/owl-compiler";
import { OwlError } from "@odoo/owl-core";
import { buildHash, version } from "../../owl-runtime/src/build_info";

const registry = ((globalThis as any)[Symbol.for("@odoo/owl/compiler")] ||= Object.create(null));
registry[`${version}+${buildHash}`] = { compile, parseXML, version, hash: buildHash, OwlError };

export { compile, parseXML };
