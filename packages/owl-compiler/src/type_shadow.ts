import {
  findInterpolations,
  isInterpolated,
  processExpr,
  render,
  tokenize,
} from "./inline_expressions";
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
  // The template a static t-call names, as the app would render it, or null
  // when the app has none by that name. A t-call renders its callee in the
  // caller's context, so the shadow writes the callee where it is called:
  // its reads are checked against the caller's component and variables.
  // Without it, a callee is not followed.
  getTemplate?: (name: string) => string | Element | null;
  // The templates an interpolated t-call may render
  // (`{{ this.constructor.rowTemplate }}`), by name, each written in place
  // as a static callee is. Without it, such a call is not followed.
  dynamicCallees?: (name: string) => string[];
  // The type of `this.props`, where it is not the component type's own
  // (an Odoo component's props field is typed any; OWL validates the static
  // schema): the shadow reads `this.props` as a value of it, and `this`
  // keeps the component type whole, its private members included.
  propsType?: string;
  // The type of the variables the template is rendered with, where it is
  // rendered with some (renderToString's context, a tooltip's info): each
  // variable it reads is a property of it. Without it, a variable the
  // template does not set is undeclared.
  variablesType?: string;
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
  // The static t-calls whose callee getTemplate did not find: the app
  // throws rendering them.
  missingCalls: string[];
  // The callees written in place, each once.
  callees: string[];
}

export interface ShadowSource {
  attribute: string;
  value: string;
  // The called template the attribute is written in, when it is not the
  // checked template itself.
  template?: string;
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
declare function __owlWith<T>(context: T, body: (this: T) => void): void;
`;

const VARIABLE_RE = /^[\p{ID_Start}_$][\p{ID_Continue}$‌‍]*$/u;

// A template variable may be named as a word TypeScript reserves (a t-call
// passing class="..."): an expression reads it as ctx["class"]. The shadow
// writes it under a name of its own.
const KEYWORDS = new Set(
  (
    "break,case,catch,class,const,continue,default,do,else,enum,export,extends,finally,for," +
    "if,import,let,super,switch,throw,try,var,while,with,yield,await,static,implements," +
    "interface,package,private,protected,public"
  ).split(",")
);

function variable(name: string): string {
  return KEYWORDS.has(name) ? `__owlVar_${name}` : name;
}

// The template variables the expressions written meanwhile read where no
// open scope from readsFrom on binds them, while a callee (or a template
// rendered with variables) is being written.
let reads: Set<string> | null = null;
let readsFrom = 0;
let writer: ShadowWriter | null = null;
// Whether `this.props` is read as __owlProps: outside a t-call-context
// callee, whose `this` is its context.
let aliasProps = false;

// The expression as TypeScript reads it. An object literal may hold `this` as
// a shorthand key, which processExpr expands and JavaScript does not.
function shadowExpr(expr: string): string {
  if (reads && writer) {
    const scopes = writer.scopes.slice(readsFrom);
    for (const name of processExpr(expr).variables) {
      if (!scopes.some((scope) => scope.has(name))) {
        reads.add(name);
      }
    }
  }
  let tokens = tokenize(expr);
  if (aliasProps) {
    const aliased = [];
    for (let i = 0; i < tokens.length; i++) {
      const before = tokens[i - 1];
      if (
        tokens[i].value === "this" &&
        tokens[i + 1]?.value === "." &&
        tokens[i + 2]?.value === "props" &&
        !(before?.type === "OPERATOR" && (before.value === "." || before.value === "?."))
      ) {
        aliased.push({ ...tokens[i], value: "__owlProps" });
        i += 2;
      } else {
        aliased.push(tokens[i]);
      }
    }
    tokens = aliased;
  }
  tokens.forEach((token, i) => {
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    if (token.type === "TEMPLATE_STRING") {
      token.value = token.replace!(shadowExpr);
    } else if (
      token.type === "SYMBOL" &&
      !token.isKeyword &&
      KEYWORDS.has(token.value) &&
      !(before?.type === "OPERATOR" && (before.value === "." || before.value === "?.")) &&
      !(after?.type === "COLON" && ["LEFT_BRACE", "COMMA"].includes(before?.type)) &&
      !(
        ["const", "let", "var", "await", "yield"].includes(token.value) &&
        ["SYMBOL", "VALUE", "TEMPLATE_STRING", "LEFT_BRACE", "LEFT_BRACKET", "LEFT_PAREN"].includes(
          after?.type
        )
      )
    ) {
      token.value =
        ["LEFT_BRACE", "COMMA"].includes(before?.type) &&
        ["RIGHT_BRACE", "COMMA"].includes(after?.type)
          ? `${token.value}: ${variable(token.value)}`
          : variable(token.value);
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
  options: TypeShadowOptions;
  lines: string[] = [];
  origins: (string | null)[] = [];
  sources: (ShadowSource | null)[] = [];
  depth = 1;
  // The t-calls being written, innermost last: a callee calling a template
  // already on it (a tree drawing its children) is not written again.
  calls: string[] = [];
  missingCalls: string[] = [];
  callees = new Set<string>();
  // The template variables each open block declares, outermost first.
  scopes: Set<string>[] = [new Set()];

  constructor(options: TypeShadowOptions) {
    this.componentType = options.componentType;
    this.options = options;
  }

  line(code: string, origin: string | null, source: ShadowSource | null = null) {
    const callee = this.calls[this.calls.length - 1];
    this.lines.push("  ".repeat(this.depth) + code);
    this.origins.push(origin && callee ? `t-call="${callee}" ${origin}` : origin);
    this.sources.push(source && callee ? { ...source, template: callee } : source);
  }

  open(code: string, origin: string | null, source: ShadowSource | null = null) {
    this.line(code, origin, source);
    this.depth++;
    this.scopes.push(new Set());
  }

  // The next branch of an if chain: `} else {` closes a block and opens one.
  branch(code: string, origin: string | null, source: ShadowSource | null = null) {
    this.depth--;
    this.scopes.pop();
    this.open(code, origin, source);
  }

  close(code = "}") {
    this.depth--;
    this.scopes.pop();
    this.line(code, null);
  }

  declare(name: string, code: string, origin: string | null, source: ShadowSource | null) {
    this.bind(name);
    this.line(code, origin, source);
  }

  bind(name: string) {
    this.scopes[this.scopes.length - 1].add(name);
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
      w.declare(name, `let ${variable(name)}: any;`, `t-set="${name}"`, {
        attribute: "t-set",
        value: name,
      });
    }
  }
}

function describe(ast: ASTDomNode | ASTComponent): string {
  return ast.type === ASTType.DomNode ? `<${ast.tag}>` : `<${ast.name}>`;
}

// The templates a t-call renders: the one its static name names, or those
// dynamicCallees gives for an interpolated one; none being written already.
function calleesOf(w: ShadowWriter, ast: { name: string }): { name: string; ast: AST }[] {
  const { getTemplate, dynamicCallees, customDirectives } = w.options;
  if (!getTemplate) {
    return [];
  }
  const names = isInterpolated(ast.name) ? (dynamicCallees?.(ast.name) ?? []) : [ast.name];
  const callees = [];
  for (const name of names) {
    if (w.calls.includes(name)) {
      continue;
    }
    const template = getTemplate(name);
    if (!template) {
      w.missingCalls.push(name);
      continue;
    }
    callees.push({ name, ast: parse(template, customDirectives) });
  }
  return callees;
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
        w.branch(`} else if (${shadowExpr(branch.condition)}) {`, `t-elif="${branch.condition}"`, {
          attribute: "t-elif",
          value: branch.condition,
        });
        emit(w, branch.content);
      }
      if (ast.tElse) {
        w.branch("} else {", "t-else");
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
        w.line(`${variable(ast.name)} = ${shadowExpr(ast.value)};`, origin, {
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
      // The collection is read outside the loop, as the runtime reads it:
      // `t-foreach="item.children" t-as="item"` reads the enclosing item.
      w.open("{", null);
      w.line(`const __owlItems = __owlLoop(${shadowExpr(ast.collection)});`, origin, source);
      w.open(`for (const [${variable(elem)}, ${elem}_value] of __owlItems) {`, origin);
      w.line(
        `const ${elem}_index = 0 as number, ${elem}_first = true as boolean, ${elem}_last = true as boolean;`,
        origin,
        source
      );
      w.line(`__owlRead(${elem}_value, ${elem}_index, ${elem}_first, ${elem}_last);`, null);
      for (const suffix of ["", "_value", "_index", "_first", "_last"]) {
        w.bind(elem + suffix);
      }
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
      const callees = calleesOf(w, ast);
      if (ast.context && !callees.length) {
        w.read(ast.context, `${origin} t-call-context`, "t-call-context");
      }
      const attrs = Object.entries(ast.attrs || {});
      if (!ast.body && !attrs.length && !callees.length) {
        return;
      }
      w.open("{", origin, source);
      // Each attribute is a variable of the callee's context, as propEntry
      // reads it, evaluated in the caller's: `record="record"` reads the
      // caller's record.
      for (const [key, value] of attrs) {
        const [name, suffix] = key.split(".");
        const expr =
          suffix === "translate"
            ? "undefined as unknown as string"
            : !value.trim()
              ? "undefined"
              : suffix === "bind"
                ? `(${shadowExpr(value)}).bind(this)`
                : shadowExpr(value);
        w.line(`const __owlArg_${name} = ${expr};`, `${origin} ${key}`, { attribute: key, value });
      }
      if (ast.body) {
        w.open("{", origin, source);
        declareContext(w, ast.body, new Set());
        emit(w, ast.body);
        w.close();
      }
      for (const callee of callees) {
        const componentType = w.componentType;
        let savedAlias = aliasProps;
        if (ast.context) {
          // The callee's `this` is the context, and its variables are the
          // attributes alone: none of the caller's reaches it.
          w.line(`const __owlContext = ${shadowExpr(ast.context)};`, `${origin} t-call-context`, {
            attribute: "t-call-context",
            value: ast.context,
          });
          w.open("__owlWith(__owlContext, function () {", null);
          w.componentType = "typeof __owlContext";
          savedAlias = aliasProps;
          aliasProps = false;
        } else {
          w.open("{", null);
        }
        const bound = new Set<string>();
        for (const [key] of attrs) {
          const name = key.split(".")[0];
          w.declare(name, `let ${variable(name)} = __owlArg_${name};`, null, null);
          bound.add(name);
        }
        // A variable the callee reads and the call does not give it is
        // undefined at runtime, read as an optional argument (t-if="group"):
        // typed any, since a guard would narrow undefined to never and report
        // the branch it guards. It is checked in the calls that give it.
        const at = w.lines.length;
        const depth = w.depth;
        // With a context, none of the caller's variables reaches it: only
        // what its own block binds counts.
        const [savedReads, savedFrom] = [reads, readsFrom];
        reads = new Set();
        readsFrom = ast.context ? w.scopes.length - 1 : 0;
        w.calls.push(callee.name);
        w.callees.add(callee.name);
        declareContext(w, callee.ast, bound);
        emit(w, callee.ast);
        w.calls.pop();
        const unset = [...reads].filter((name) => name !== "this");
        [reads, readsFrom] = [savedReads, savedFrom];
        const declarations = unset.map(
          (name) => "  ".repeat(depth) + `const ${variable(name)}: any = undefined;`
        );
        w.lines.splice(at, 0, ...declarations);
        w.origins.splice(at, 0, ...declarations.map(() => null));
        w.sources.splice(at, 0, ...declarations.map(() => null));
        w.componentType = componentType;
        aliasProps = savedAlias;
        w.close(ast.context ? "});" : "}");
      }
      w.close();
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
            w.declare(
              slot.scope,
              `const ${variable(slot.scope)}: any = {};`,
              `${origin} t-slot-scope`,
              {
                attribute: "t-slot-scope",
                value: slot.scope,
              }
            );
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
  const w = new ShadowWriter(options);
  writer = w;
  const header = `function ${options.functionName}(this: ${options.componentType}) {`;
  if (options.globalsType) {
    w.line(`const __globals__ = undefined as unknown as ${options.globalsType};`, null);
    w.line(`__owlRead(__globals__);`, null);
  }
  if (options.propsType) {
    w.line(`const __owlProps = undefined as unknown as ${options.propsType};`, null);
    w.line(`__owlRead(__owlProps);`, null);
    aliasProps = true;
  }
  if (options.variablesType) {
    w.line(`const __owlVars = undefined as unknown as ${options.variablesType};`, null);
    w.line(`__owlRead(__owlVars);`, null);
    reads = new Set();
    readsFrom = 0;
  }
  const at = w.lines.length;
  declareContext(w, ast, new Set());
  emit(w, ast);
  aliasProps = false;
  if (options.variablesType) {
    const given = [...reads!].filter((name) => name !== "this");
    reads = null;
    w.lines.splice(at, 0, ...given.map((name) => `  const ${variable(name)} = __owlVars.${name};`));
    w.origins.splice(at, 0, ...given.map((name) => `variable "${name}"`));
    w.sources.splice(at, 0, ...given.map(() => null));
  }
  writer = null;
  return {
    code: [header, ...w.lines, "}"].join("\n"),
    origins: [null, ...w.origins, null],
    sources: [null, ...w.sources, null],
    missingCalls: w.missingCalls,
    callees: [...w.callees],
  };
}
