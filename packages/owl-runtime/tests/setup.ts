import "../../../tools/testing/setup";
// Wire compile + parseXML into TemplateSet for tests that use xml templates.
import { compile, parseXML } from "@odoo/owl-compiler";
import { buildHash, version } from "../src/build_info";
import { TemplateSet } from "../src/template_set";

TemplateSet.compiler = { compile, parseXML, version, hash: buildHash };
