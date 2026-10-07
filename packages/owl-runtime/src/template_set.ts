import { debug, debugLog, debugNow, getScope, OwlError } from "@odoo/owl-core";
import type { compile, CustomDirectives, Template, TemplateFunction } from "@odoo/owl-compiler";
import { createBlock, html, list, multi, text, toggler } from "./blockdom";
import { helpers } from "./rendering/template_helpers";
import { ComponentNode } from "./component_node";
import { build as BUILD } from "./build_info";
import { bundledCompiler } from "./bundled_compiler";

const bdom = { text, createBlock, list, multi, html, toggler };

export interface TemplateSetConfig {
  dev?: boolean;
  translatableAttributes?: string[];
  translateFn?: (s: string, translationCtx: string) => string;
  templates?: string | Document | Record<string, string | TemplateFunction>;
  getTemplate?: (s: string) => Element | Function | string | void;
  customDirectives?: CustomDirectives;
  globalValues?: object;
}

export interface TemplateCompiler {
  compile: typeof compile;
  parseXML: (xml: string) => Document;
  // a compiler module's build, which must be the runtime's, and the class of
  // the errors it throws, which the runtime rethrows as its own OwlError
  version?: string;
  hash?: string;
  OwlError?: new (...args: any[]) => Error;
}

// where the compiler modules (@odoo/owl/compiler) register themselves, each
// under its build ("<version>+<hash>"): a key every owl build agrees on, so
// that a compiler module and its runtime need not resolve to one module
// instance (an import map, a bundler and Node's package exports each resolve
// them their own way), and two runtime builds on one page each find their own
export const COMPILER_KEY = Symbol.for("@odoo/owl/compiler");

// undefined: the compiler module of this build, once registered; null: none
let ownCompiler: TemplateCompiler | null | undefined;

function registeredBuilds(): string[] {
  return Object.keys((globalThis as any)[COMPILER_KEY] || {});
}

/**
 * Refuses a compiler of another build: its code calls the runtime's helpers by
 * name.
 */
function checkBuild(compiler: TemplateCompiler) {
  if (compiler.version === undefined || compiler.hash === undefined) {
    throw new OwlError(
      `The template compiler does not name its build, as the compiler module of an owl older than this runtime (${BUILD}) does: load the owl.compiler.es.js built with this runtime`
    );
  }
  const build = `${compiler.version}+${compiler.hash}`;
  if (build !== BUILD) {
    throw new OwlError(
      `The template compiler is build ${build}, but the runtime is ${BUILD}: load the owl.compiler.es.js built with this runtime`
    );
  }
}

export class TemplateSet {
  /**
   * The compiler: the full build's own, else the compiler module of this
   * runtime's build once it is registered. Setting a compiler checks that it
   * is of this build; null leaves the runtime without one, undefined takes
   * the build's own or the registered one again.
   */
  static get compiler(): TemplateCompiler | null {
    if (ownCompiler === undefined) {
      if (bundledCompiler) {
        if (debug.template) {
          debugLog("template", `bundled compiler ${BUILD} installed`);
        }
        ownCompiler = bundledCompiler;
        return ownCompiler;
      }
      const registered: TemplateCompiler | undefined = (globalThis as any)[COMPILER_KEY]?.[BUILD];
      if (!registered) {
        return null;
      }
      if (debug.template) {
        debugLog("template", `compiler module ${BUILD} installed`);
      }
      ownCompiler = registered;
    }
    return ownCompiler;
  }
  static set compiler(compiler: TemplateCompiler | null | undefined) {
    if (compiler) {
      checkBuild(compiler);
    }
    ownCompiler = compiler;
  }
  static registerTemplate(name: string, fn: TemplateFunction) {
    globalTemplates[name] = fn;
  }
  dev: boolean;
  rawTemplates: typeof globalTemplates = Object.create(globalTemplates);
  templates: { [name: string]: Template } = Object.create(null);
  getRawTemplate?: (s: string) => Element | Function | string | void;
  translateFn?: (s: string, translationCtx: string) => string;
  translatableAttributes?: string[];
  customDirectives: CustomDirectives;
  runtimeUtils: object;
  hasGlobalValues: boolean;

  constructor(config: TemplateSetConfig = {}) {
    this.dev = config.dev || false;
    this.translateFn = config.translateFn;
    this.translatableAttributes = config.translatableAttributes;
    if (config.templates) {
      if (config.templates instanceof Document || typeof config.templates === "string") {
        this.addTemplates(config.templates);
      } else {
        for (const name in config.templates) {
          this.addTemplate(name, config.templates[name]);
        }
      }
    }
    this.getRawTemplate = config.getTemplate;
    this.customDirectives = config.customDirectives || {};
    this.runtimeUtils = { ...helpers, __globals__: config.globalValues || {} };
    this.hasGlobalValues = Boolean(config.globalValues && Object.keys(config.globalValues).length);
  }

  addTemplate(name: string, template: string | Element | TemplateFunction) {
    if (name in this.rawTemplates) {
      // this check can be expensive, just silently ignore double definitions outside dev mode
      if (!this.dev) {
        return;
      }
      const rawTemplate = this.rawTemplates[name];
      if (areTemplatesEqual(rawTemplate, template)) {
        return;
      }
      throw new OwlError(`Template ${name} already defined with different content`);
    }
    this.rawTemplates[name] = template;
  }

  addTemplates(xml: string | Document) {
    if (!xml) {
      // empty string
      return;
    }
    xml = xml instanceof Document ? xml : this._parseXML(xml);
    for (const template of xml.querySelectorAll("[t-name]")) {
      const name = template.getAttribute("t-name")!;
      this.addTemplate(name, template);
    }
  }

  getTemplate(name: string): Template {
    const cacheKey = name;
    if (!(cacheKey in this.templates)) {
      const rawTemplate = this.getRawTemplate?.(name) || this.rawTemplates[name];
      if (rawTemplate === undefined) {
        let extraInfo = "";
        const scope = getScope();
        if (scope instanceof ComponentNode) {
          extraInfo = ` (for component "${scope.componentName}")`;
        }
        throw new OwlError(`Missing template: "${name}"${extraInfo}`);
      }
      const isFn = typeof rawTemplate === "function" && !(rawTemplate instanceof Element);
      const start = debug.template ? debugNow() : -1;
      const templateFn = isFn ? rawTemplate : this._compileTemplate(name, rawTemplate);
      if (debug.template) {
        debugLog(
          "template",
          isFn
            ? `${name}: precompiled`
            : `${name}: compiled${start < 0 ? "" : ` in ${(debugNow() - start).toFixed(2)} ms`}, ${String(templateFn).length} chars`
        );
      }
      // first add a function to lazily get the template, in case there is a
      // recursive call to the template name
      const templates = this.templates;
      this.templates[cacheKey] = function (context, parent) {
        return templates[cacheKey].call(this, context, parent);
      };
      try {
        this.templates[cacheKey] = templateFn(this, bdom, this.runtimeUtils);
      } catch (e) {
        delete this.templates[cacheKey];
        throw e;
      }
    }
    return this.templates[cacheKey];
  }

  _compileTemplate(name: string, template: string | Element): TemplateFunction {
    const compiler = TemplateSet.compiler;
    if (!compiler) {
      throw new OwlError(
        `Unable to compile a template: load the compiler module (@odoo/owl/compiler) of this runtime's build or use the full build${missingCompiler()}`
      );
    }
    try {
      return compiler.compile(template, {
        name,
        dev: this.dev,
        translateFn: this.translateFn,
        translatableAttributes: this.translatableAttributes,
        customDirectives: this.customDirectives,
        hasGlobalValues: this.hasGlobalValues,
      });
    } catch (error) {
      throw asOwnError(error, compiler);
    }
  }

  private _parseXML(xml: string): Document {
    const compiler = TemplateSet.compiler;
    if (!compiler) {
      throw new OwlError(
        `Unable to parse XML templates: load the compiler module (@odoo/owl/compiler) of this runtime's build, use the full build, or pass a Document instance${missingCompiler()}`
      );
    }
    try {
      return compiler.parseXML(xml);
    } catch (error) {
      throw asOwnError(error, compiler);
    }
  }
}

/**
 * What the runtime lacks a compiler for, when it is not the obvious: compiler
 * modules of other builds only, or none by choice.
 */
function missingCompiler(): string {
  if (ownCompiler === null) {
    return ` (TemplateSet.compiler was set to null)`;
  }
  const builds = registeredBuilds();
  return builds.length
    ? ` (the runtime is ${BUILD}; the compiler modules loaded are ${builds.join(", ")})`
    : "";
}

/**
 * An error of the compiler module's own OwlError class as this runtime's: the
 * page catches the runtime's class.
 */
function asOwnError(error: unknown, compiler: TemplateCompiler): unknown {
  const ForeignError = compiler.OwlError;
  if (!ForeignError || ForeignError === OwlError || !(error instanceof ForeignError)) {
    return error;
  }
  const ownError = new OwlError(error.message);
  ownError.cause = error;
  return ownError;
}

// -----------------------------------------------------------------------------
//  xml tag helper
// -----------------------------------------------------------------------------
export const globalTemplates: { [key: string]: string | Element | TemplateFunction } =
  Object.create(null);

export const xml = /* @__PURE__ */ Object.assign(
  function (...args: Parameters<typeof String.raw>): string {
    const name = `__template__${xml.nextId++}`;
    const value = String.raw(...args);
    globalTemplates[name] = value;
    return name;
  },
  { nextId: 1 }
);

/**
 * The template of one of owl's components, made on its first read and the
 * class's own `template` from then on, so that importing owl registers no
 * template: `static get template() { return ownTemplate(Portal, "Portal").xml`...`; }`.
 * It has a name of its own, not one of xml's counter (which a test may reset);
 * the tag is spelled `.xml` so that a scanner of xml templates, as Odoo's
 * precompiler is, finds it in the build.
 */
export function ownTemplate(C: Function, name: string): { xml: typeof String.raw } {
  return {
    xml(...args) {
      const templateName = `__owl__${name}`;
      globalTemplates[templateName] = String.raw(...args);
      Object.defineProperty(C, "template", {
        value: templateName,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return templateName;
    },
  };
}

function areTemplatesEqual(t1: any, t2: any): boolean {
  if (t1 === t2) {
    return true;
  }
  if ((typeof t1 === "function") !== (typeof t2 === "function")) {
    return false;
  }
  const s1 = t1 instanceof Element ? t1.outerHTML : String(t1);
  const s2 = t2 instanceof Element ? t2.outerHTML : String(t2);
  return s1 === s2;
}
