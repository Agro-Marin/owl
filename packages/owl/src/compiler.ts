// The template compiler alone, for a page that loads the runtime build as
// @odoo/owl: importing it installs the compiler, after which the runtime
// compiles templates given as strings or elements like the full build does.
// Built with @odoo/owl external, so it shares the runtime's classes.
import { TemplateSet } from "@odoo/owl-runtime";
import { compile, parseXML } from "@odoo/owl-compiler";

TemplateSet.compiler = { compile, parseXML };

export { compile, parseXML };
