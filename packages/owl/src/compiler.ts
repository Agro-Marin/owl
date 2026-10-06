// The template compiler alone, for a page that loads the runtime build:
// importing it registers the compiler under a global key the runtime looks up
// (COMPILER_KEY), so that it installs whichever way the two modules resolve.
// The runtime checks that the compiler is of its own build.
import { compile, parseXML } from "@odoo/owl-compiler";
import { OwlError } from "@odoo/owl-core";
import { buildHash, version } from "../../owl-runtime/src/build_info";

(globalThis as any)[Symbol.for("@odoo/owl/compiler")] = {
  compile,
  parseXML,
  version,
  hash: buildHash,
  OwlError,
};

export { compile, parseXML };
