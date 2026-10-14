import { OwlError } from "@odoo/owl-core";
import { CodeGenerator, type CompileOptions } from "./code_generator";
import { parse } from "./parser";

export type CustomDirectives = Record<
  string,
  (node: Element, value: string, modifier: string[]) => void
>;

export type Template = (context: any, vnode: any, key?: string) => any;

export type TemplateFunction = (app: any, bdom: any, helpers: any) => Template;

export function compile(
  template: string | Element,
  options: CompileOptions = {
    hasGlobalValues: false,
  }
): TemplateFunction {
  const ast = parse(template, options.customDirectives);

  const codeGenerator = new CodeGenerator(ast, options);
  const code = codeGenerator.generateCode();
  try {
    return new Function("app, bdom, helpers", code) as TemplateFunction;
  } catch (originalError: any) {
    const { name } = options;
    const nameStr = name ? `template "${name}"` : "anonymous template";
    const err = new OwlError(
      `Failed to compile ${nameStr}: ${originalError.message}\n\ngenerated code:\nfunction(app, bdom, helpers) {\n${code}\n}`
    );
    err.cause = originalError;
    throw err;
  }
}

export { parseXML } from "./parse_xml";
export type { CompileOptions } from "./code_generator";
