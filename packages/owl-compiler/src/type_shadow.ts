import { findInterpolations, processExpr, render, tokenize } from "./inline_expressions";
import type { CustomDirectives } from "./index";
import { AST, ASTComponent, ASTDomNode, ASTType, parse } from "./parser";

// A template's type shadow: TypeScript that holds each of its expressions
// where the template evaluates it, `this` typed as the component class, so a
// type checker reports what the template reads that the component does not
// have. Its control flow mirrors the template's (t-if is an if, t-foreach a
// loop over what the runtime iterates), so narrowing and loop variables are
// typed as the runtime sees them. It is never run.

export interface TypeShadowOptions {
  // The TypeScript type of the component the template renders, as an
  // expression in the shadow's file: `import("@web/x").X`, or a name the
  // caller's file declares.
  componentType: string;
  // The function's name; a valid identifier.
  functionName: string;
  // The type of the app's globalValues, which a template reads as
  // `__globals__.<name>` (a bare name is never one of them: it reads the
  // template's own variables). Without it, `__globals__` is undeclared, as
  // it is at runtime in an app that has none.
  globalsType?: string;
  // The app's custom directives, which the compiler applies before parsing.
  customDirectives?: CustomDirectives;
}

export interface TypeShadow {
  // The function's source, without the prelude.
  code: string;
  // For each line of `code`, what in the template it comes from, or null.
  origins: (string | null)[];
  // For each line of `code`, the attribute it reads as the template writes
  // it, or null: what an editor looks for to place a diagnostic, since the
  // parsed template keeps no position.
  sources: (ShadowSource | null)[];
}

export interface ShadowSource {
  attribute: string;
  value: string;
}

// What every shadow refers to: declared once per checked file. A handler is
// typed as a method, whose parameter is checked both ways: one that declares
// what it knows of the event (PointerEvent & { target: HTMLImageElement }) is
// accepted, one that expects another event is not. A bare name
// reads the template's variables only: the root context is { this, __owl__ }.
export const TYPE_SHADOW_PRELUDE = `type __OwlLoopKey<C> = 0 extends 1 & C ? any
  : C extends readonly (infer T)[] ? T
  : C extends ReadonlyMap<infer K, unknown> ? K
  : C extends Iterable<infer T> ? T
  : C extends object ? Extract<keyof C, string>
  : never;
type __OwlLoopValue<C> = 0 extends 1 & C ? any
  : C extends readonly (infer T)[] ? T
  : C extends ReadonlyMap<unknown, infer V> ? V
  : C extends Iterable<infer T> ? T
  : C extends object ? C[keyof C]
  : never;
declare function __owlLoop<C>(collection: C): Iterable<[__OwlLoopKey<C>, __OwlLoopValue<C>]>;
type __OwlEvent<K extends string> = K extends keyof HTMLElementEventMap ? HTMLElementEventMap[K] : Event;
type __OwlElement<T extends string> = T extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[T]
  : T extends keyof SVGElementTagNameMap ? SVGElementTagNameMap[T]
  : HTMLElement;
type __OwlMethodEvent<K extends string> = Omit<__OwlEvent<K>, "target" | "currentTarget"> & { target: any; currentTarget: any };
type __OwlHandler<C, E> = { handle(this: C, ev: E): unknown }["handle"];
declare function __owlHandler<C, E>(component: C, handler: __OwlHandler<C, E>): void;
declare function __owlRead(...values: unknown[]): void;
`;

const VARIABLE_RE = /^[\p{ID_Start}_$][\p{ID_Continue}$‌‍]*$/u;

// The expression as TypeScript reads it. An object literal may hold `this` as
// a shorthand key, which processExpr expands and JavaScript does not.
function shadowExpr(expr: string): string {
  const tokens = tokenize(expr);
  tokens.forEach((token, i) => {
    if (token.type === "TEMPLATE_STRING") {
      token.value = token.replace!(shadowExpr);
    } else if (
      token.value === "this" &&
      ["LEFT_BRACE", "COMMA"].includes(tokens[i - 1]?.type) &&
      ["RIGHT_BRACE", "COMMA"].includes(tokens[i + 1]?.type)
    ) {
      token.value = "this: this";
    }
  });
  return render(tokens);
}

function shadowInterpolation(text: string): string {
  return findInterpolations(text)
    .map(({ expr }) => shadowExpr(expr))
    .join(", ");
}

function eventName(key: string): string {
  return key.split(".")[0];
}

class ShadowWriter {
  componentType: string;
  lines: string[] = [];
  origins: (string | null)[] = [];
  sources: (ShadowSource | null)[] = [];
  depth = 1;

  constructor(componentType: string) {
    this.componentType = componentType;
  }

  line(code: string, origin: string | null, source: ShadowSource | null = null) {
    this.lines.push("  ".repeat(this.depth) + code);
    this.origins.push(origin);
    this.sources.push(source);
  }

  open(code: string, origin: string | null, source: ShadowSource | null = null) {
    this.line(code, origin, source);
    this.depth++;
  }

  close(code = "}") {
    this.depth--;
    this.line(code, null);
  }

  read(expr: string, origin: string, attribute: string) {
    if (expr.trim()) {
      this.line(`__owlRead(${shadowExpr(expr)});`, origin, { attribute, value: expr });
    }
  }

  // A prop, a slot's or a t-slot's attribute, as propEntry reads it: with
  // .translate it is text, with .bind a function bound to the component.
  props(props: { [name: string]: string } | null, where: string) {
    for (const prop in props || {}) {
      const value = props![prop];
      const [, suffix] = prop.split(".");
      if (suffix === "translate" || !value.trim()) {
        continue;
      }
      const expr = shadowExpr(value);
      this.line(
        suffix === "bind" ? `__owlRead((${expr}).bind(this));` : `__owlRead(${expr});`,
        `${where} ${prop}`,
        { attribute: prop, value }
      );
    }
  }

  // An arrow written in the template is typed by the event: its
  // currentTarget is the listener's element, and so is its target where
  // nothing inside it can be (an <input>, a <textarea>, a <select>'s change
  // and input). A method brings its own parameter type, checked against the
  // event with its targets left to what the method declares of them.
  handlers(on: { [event: string]: string } | null, where: string, tag: string | null = null) {
    for (const key in on || {}) {
      const handler = on![key];
      if (handler.trim()) {
        const name = eventName(key);
        const element = tag ? `__OwlElement<${JSON.stringify(tag)}>` : "EventTarget";
        const isTarget =
          tag === "input" ||
          tag === "textarea" ||
          (tag === "select" && (name === "change" || name === "input"));
        const target = isTarget ? element : "EventTarget";
        const isArrow = processExpr(handler).arrow !== null;
        const event = isArrow
          ? `__OwlEvent<${JSON.stringify(name)}> & { currentTarget: ${element}; target: ${target} }`
          : `__OwlMethodEvent<${JSON.stringify(name)}>`;
        this.line(
          `__owlHandler<${this.componentType}, ${event}>(this, ${shadowExpr(handler)});`,
          `${where} t-on-${key}`,
          { attribute: `t-on-${key}`, value: handler }
        );
      }
    }
  }
}

// The names t-set binds in a context: the runtime's ctx is one object per
// template, loop iteration and slot, so a t-set inside a t-if is read by what
// follows the t-if. Declared where the context starts, they are typed any.
function collectSetNames(ast: AST | null, names: Set<string>) {
  if (!ast) {
    return;
  }
  switch (ast.type) {
    case ASTType.TSet:
      names.add(ast.name);
      ast.body?.forEach((child) => collectSetNames(child, names));
      break;
    case ASTType.DomNode:
    case ASTType.Multi:
      ast.content.forEach((child) => collectSetNames(child, names));
      break;
    case ASTType.TIf:
      collectSetNames(ast.content, names);
      ast.tElif?.forEach((branch) => collectSetNames(branch.content, names));
      collectSetNames(ast.tElse, names);
      break;
    case ASTType.TOut:
      ast.body?.forEach((child) => collectSetNames(child, names));
      break;
    case ASTType.TKey:
      collectSetNames(ast.content, names);
      break;
    case ASTType.TCallSlot:
      collectSetNames(ast.defaultContent, names);
      break;
    case ASTType.TDebug:
    case ASTType.TLog:
    case ASTType.TTranslation:
    case ASTType.TTranslationContext:
      collectSetNames(ast.content, names);
      break;
    // A loop, a call's body and a component's slots each start a context of
    // their own.
  }
}

function declareContext(w: ShadowWriter, ast: AST | null, bound: Set<string>) {
  const names = new Set<string>();
  collectSetNames(ast, names);
  for (const name of names) {
    if (!bound.has(name)) {
      w.line(`let ${name}: any;`, `t-set="${name}"`, { attribute: "t-set", value: name });
    }
  }
}

function describe(ast: ASTDomNode | ASTComponent): string {
  return ast.type === ASTType.DomNode ? `<${ast.tag}>` : `<${ast.name}>`;
}

function emit(w: ShadowWriter, ast: AST | null): void {
  if (!ast) {
    return;
  }
  switch (ast.type) {
    case ASTType.Text:
    case ASTType.TCallBlock:
      return;
    case ASTType.DomNode: {
      const where = describe(ast);
      if (ast.dynamicTag) {
        w.read(ast.dynamicTag, `${where} t-tag`, "t-tag");
      }
      for (const name in ast.attrs || {}) {
        const value = ast.attrs![name];
        if (name.startsWith("t-attf-")) {
          const parts = shadowInterpolation(value);
          if (parts) {
            w.line(`__owlRead(${parts});`, `${where} ${name}`, { attribute: name, value });
          }
        } else if (name === "t-att" || name.startsWith("t-att-")) {
          w.read(value, `${where} ${name}`, name);
        }
      }
      if (ast.ref) {
        w.read(ast.ref, `${where} t-ref`, "t-ref");
      }
      if (ast.model) {
        w.read(ast.model.expr, `${where} t-model`, "t-model");
      }
      w.handlers(ast.on, where, ast.dynamicTag ? "" : ast.tag);
      ast.content.forEach((child) => emit(w, child));
      return;
    }
    case ASTType.Multi:
      ast.content.forEach((child) => emit(w, child));
      return;
    case ASTType.TOut:
      w.read(ast.expr, `t-out="${ast.expr}"`, "t-out");
      ast.body?.forEach((child) => emit(w, child));
      return;
    case ASTType.TIf: {
      w.open(`if (${shadowExpr(ast.condition)}) {`, `t-if="${ast.condition}"`, {
        attribute: "t-if",
        value: ast.condition,
      });
      emit(w, ast.content);
      for (const branch of ast.tElif || []) {
        w.depth--;
        w.open(`} else if (${shadowExpr(branch.condition)}) {`, `t-elif="${branch.condition}"`, {
          attribute: "t-elif",
          value: branch.condition,
        });
        emit(w, branch.content);
      }
      if (ast.tElse) {
        w.depth--;
        w.open("} else {", "t-else");
        emit(w, ast.tElse);
      }
      w.close();
      return;
    }
    case ASTType.TSet: {
      // A text body (defaultValue) is a translated string, the value's
      // fallback when there is a t-value: there is nothing in it to read.
      const origin = `t-set="${ast.name}"`;
      if (ast.value) {
        w.line(`${ast.name} = ${shadowExpr(ast.value)};`, origin, {
          attribute: "t-value",
          value: ast.value,
        });
      }
      ast.body?.forEach((child) => emit(w, child));
      return;
    }
    case ASTType.TForEach: {
      const elem = ast.elem;
      const origin = `t-foreach="${ast.collection}" t-as="${elem}"`;
      const source = { attribute: "t-foreach", value: ast.collection };
      w.open(
        `for (const [${elem}, ${elem}_value] of __owlLoop(${shadowExpr(ast.collection)})) {`,
        origin,
        source
      );
      w.line(
        `const ${elem}_index = 0 as number, ${elem}_first = true as boolean, ${elem}_last = true as boolean;`,
        origin,
        source
      );
      w.line(`__owlRead(${elem}_value, ${elem}_index, ${elem}_first, ${elem}_last);`, null);
      const bound = new Set([elem]);
      declareContext(w, ast.body, bound);
      if (ast.key) {
        w.read(ast.key, `${origin} t-key`, "t-key");
      }
      if (ast.memo) {
        w.read(ast.memo, `${origin} t-memo`, "t-memo");
      }
      emit(w, ast.body);
      w.close();
      return;
    }
    case ASTType.TKey:
      w.read(ast.expr, `t-key="${ast.expr}"`, "t-key");
      emit(w, ast.content);
      return;
    case ASTType.TCall: {
      const origin = `t-call="${ast.name}"`;
      const source = { attribute: "t-call", value: ast.name };
      const name = shadowInterpolation(ast.name);
      if (name) {
        w.line(`__owlRead(${name});`, origin, source);
      }
      if (ast.context) {
        w.read(ast.context, `${origin} t-call-context`, "t-call-context");
      }
      if (ast.body) {
        w.open("{", origin, source);
        declareContext(w, ast.body, new Set());
        emit(w, ast.body);
        w.close();
      }
      return;
    }
    case ASTType.TComponent: {
      const where = describe(ast);
      if (ast.isDynamic) {
        w.read(ast.name, `${where} t-component`, "t-component");
      }
      if (ast.dynamicProps) {
        w.read(ast.dynamicProps, `${where} t-props`, "t-props");
      }
      w.props(ast.props, where);
      w.handlers(ast.on, where);
      for (const slotName in ast.slots || {}) {
        const slot = ast.slots![slotName];
        const origin = `${where} t-set-slot="${slotName}"`;
        w.props(slot.attrs, origin);
        w.handlers(slot.on, origin);
        if (slot.content) {
          w.open("{", origin, { attribute: "t-set-slot", value: slotName });
          const bound = new Set<string>();
          if (slot.scope && VARIABLE_RE.test(slot.scope)) {
            w.line(`const ${slot.scope}: any = {};`, `${origin} t-slot-scope`, {
              attribute: "t-slot-scope",
              value: slot.scope,
            });
            bound.add(slot.scope);
          }
          declareContext(w, slot.content, bound);
          emit(w, slot.content);
          w.close();
        }
      }
      return;
    }
    case ASTType.TCallSlot: {
      const origin = `t-call-slot="${ast.name}"`;
      const name = shadowInterpolation(ast.name);
      if (name) {
        w.line(`__owlRead(${name});`, origin, { attribute: "t-call-slot", value: ast.name });
      }
      if (ast.dynamicProps) {
        w.read(ast.dynamicProps, `${origin} t-props`, "t-props");
      }
      w.props(ast.attrs, origin);
      w.handlers(ast.on, origin);
      emit(w, ast.defaultContent);
      return;
    }
    case ASTType.TLog:
      w.read(ast.expr, `t-log="${ast.expr}"`, "t-log");
      emit(w, ast.content);
      return;
    case ASTType.TDebug:
    case ASTType.TTranslation:
    case ASTType.TTranslationContext:
      emit(w, ast.content);
      return;
  }
}

export function compileTypeShadow(
  template: string | Element,
  options: TypeShadowOptions
): TypeShadow {
  const ast = parse(template, options.customDirectives);
  const w = new ShadowWriter(options.componentType);
  const header = `function ${options.functionName}(this: ${options.componentType}) {`;
  if (options.globalsType) {
    w.line(`const __globals__ = undefined as unknown as ${options.globalsType};`, null);
    w.line(`__owlRead(__globals__);`, null);
  }
  declareContext(w, ast, new Set());
  emit(w, ast);
  return {
    code: [header, ...w.lines, "}"].join("\n"),
    origins: [null, ...w.origins, null],
    sources: [null, ...w.sources, null],
  };
}
