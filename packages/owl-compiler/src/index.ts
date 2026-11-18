import { OwlError } from "@odoo/owl-core";
import { CodeGenerator, type CompileOptions } from "./code_generator";
import { recordExpressions } from "./inline_expressions";
import { parse } from "./parser";
import { parseXML } from "./parse_xml";

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
  const templateName = options.name ? `template "${options.name}"` : "anonymous template";
  const expressions: [string, string][] = [];
  let code: string;
  try {
    code = recordExpressions(expressions, () =>
      new CodeGenerator(parse(template, options.customDirectives), options).generateCode()
    );
  } catch (error) {
    if (error instanceof OwlError && options.name && !error.message.includes(templateName)) {
      error.message += ` (in ${templateName})`;
    }
    throw error;
  }
  try {
    return new Function("app, bdom, helpers", code) as TemplateFunction;
  } catch (originalError: any) {
    const culprit = invalidExpression(expressions);
    const err = new OwlError(
      culprit
        ? `Failed to compile ${templateName}: invalid expression \`${culprit.source}\`${attributeOf(template, culprit.source)}: ${culprit.message}`
        : `Failed to compile ${templateName}: ${originalError.message}\n\ngenerated code:\nfunction(app, bdom, helpers) {\n${code}\n}`
    );
    err.cause = originalError;
    throw err;
  }
}

function invalidExpression(
  expressions: [string, string][]
): { source: string; message: string } | null {
  for (const [source, compiled] of expressions) {
    try {
      new Function(`return (${compiled}\n);`);
    } catch (error: any) {
      return { source, message: error.message };
    }
  }
  return null;
}

// The template is read as written: parse() works on a copy of an Element.
function attributeOf(template: string | Element, expression: string): string {
  let root: Element;
  try {
    root = typeof template === "string" ? parseXML(`<t>${template}</t>`).documentElement : template;
  } catch {
    return "";
  }
  const elements = [root, ...root.querySelectorAll("*")];
  for (const matches of [
    (value: string) => value === expression,
    (value: string) => value.includes(expression),
  ]) {
    for (const element of elements) {
      for (const { name, value } of element.attributes) {
        if (matches(value)) {
          return ` in ${name}="${value}" (on a <${element.tagName}>)`;
        }
      }
    }
  }
  return "";
}

export { parseXML };
export type { CompileOptions } from "./code_generator";
