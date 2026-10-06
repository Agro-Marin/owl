// The template compiler alone, for a page that loads the runtime build:
// importing it registers the compiler, under its build, in a global registry
// the runtime looks up (COMPILER_KEY), so that it installs whichever way the
// two modules resolve; a runtime takes the compiler of its own build only.
import { compile, parseXML } from "@odoo/owl-compiler";
import { OwlError } from "@odoo/owl-core";
import { buildHash, version } from "../../owl-runtime/src/build_info";

const registry = ((globalThis as any)[Symbol.for("@odoo/owl/compiler")] ||= Object.create(null));
registry[`${version}+${buildHash}`] = { compile, parseXML, version, hash: buildHash, OwlError };

export { compile, parseXML };
