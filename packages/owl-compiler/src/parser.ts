import { CustomDirectives } from ".";
import { OwlError } from "@odoo/owl-core";
import { parseXML } from "./parse_xml";

// -----------------------------------------------------------------------------
// AST Type definition
// -----------------------------------------------------------------------------

export type EventHandlers = { [eventName: string]: string };
export type Attrs = { [attrs: string]: string };

export const ASTType = {
  Text: 0,
  DomNode: 2,
  Multi: 3,
  TIf: 4,
  TSet: 5,
  TCall: 6,
  TOut: 7,
  TForEach: 8,
  TKey: 9,
  TComponent: 10,
  TDebug: 11,
  TLog: 12,
  TCallSlot: 13,
  TCallBlock: 14,
  TTranslation: 15,
  TTranslationContext: 16,
} as const;
export type ASTType = (typeof ASTType)[keyof typeof ASTType];

interface BaseAST {
  type: ASTType;
  hasNoRepresentation?: true;
}

export interface ASTText extends BaseAST {
  type: (typeof ASTType)["Text"];
  value: string;
}

interface TModelInfo {
  expr: string;
  targetAttr: string;
  eventType: "change" | "click" | "input";
  shouldTrim: boolean;
  shouldNumberize: boolean;
  hasDynamicChildren: boolean;
  specialInitTargetAttr: string | null;
  isProxy: boolean;
}

export interface ASTDomNode extends BaseAST {
  type: (typeof ASTType)["DomNode"];
  tag: string;
  content: AST[];
  attrs: Attrs | null;
  attrsTranslationCtx: Attrs | null;
  ref: string | null;
  on: EventHandlers | null;
  model: TModelInfo | null;
  dynamicTag: string | null;
  ns: string | null;
}

export interface ASTMulti extends BaseAST {
  type: (typeof ASTType)["Multi"];
  content: AST[];
}

export interface ASTTOut extends BaseAST {
  type: (typeof ASTType)["TOut"];
  expr: string;
  body: AST[] | null;
}

export interface ASTTif extends BaseAST {
  type: (typeof ASTType)["TIf"];
  condition: string;
  content: AST;
  tElif: { condition: string; content: AST }[] | null;
  tElse: AST | null;
}

export interface ASTTSet extends BaseAST {
  type: (typeof ASTType)["TSet"];
  name: string;
  value: string | null; // value defined in attribute
  defaultValue: string | null; // value defined in body, if text
  body: AST[] | null; // content of body if not text
  hasNoRepresentation: true;
}

export const ForEachNoFlag = {
  First: 1,
  Last: 2,
  Index: 4,
  Value: 8,
} as const;

export interface ASTTForEach extends BaseAST {
  type: (typeof ASTType)["TForEach"];
  collection: string;
  elem: string;
  body: AST;
  noFlags: number;
  key: string;
  memo?: string;
  // whether the memoized item renders child components or memoized lists of
  // its own, to carry on a hit
  memoContent?: boolean;
}

export interface ASTTKey extends BaseAST {
  type: (typeof ASTType)["TKey"];
  expr: string;
  content: AST;
}

export interface ASTTCall extends BaseAST {
  type: (typeof ASTType)["TCall"];
  name: string;
  attrs: Attrs | null;
  attrsTranslationCtx: Attrs | null;
  body: AST | null;
  context: string | null;
}

interface SlotDefinition {
  content: AST | null;
  scope: string | null;
  on: EventHandlers | null;
  attrs: Attrs | null;
  attrsTranslationCtx: Attrs | null;
}

export interface ASTComponent extends BaseAST {
  type: (typeof ASTType)["TComponent"];
  name: string;
  isDynamic: boolean;
  dynamicProps: string | null;
  on: EventHandlers | null;
  props: { [name: string]: string } | null;
  propsTranslationCtx: { [name: string]: string } | null;
  slots: { [name: string]: SlotDefinition } | null;
}

export interface ASTTCallSlot extends BaseAST {
  type: (typeof ASTType)["TCallSlot"];
  name: string;
  dynamicProps: string | null;
  attrs: Attrs | null;
  attrsTranslationCtx: Attrs | null;
  on: EventHandlers | null;
  defaultContent: AST | null;
}

export interface ASTTCallBlock extends BaseAST {
  type: (typeof ASTType)["TCallBlock"];
  name: string;
}

export interface ASTDebug extends BaseAST {
  type: (typeof ASTType)["TDebug"];
  content: AST | null;
}

export interface ASTLog extends BaseAST {
  type: (typeof ASTType)["TLog"];
  expr: string;
  content: AST | null;
}

export interface ASTTranslation extends BaseAST {
  type: (typeof ASTType)["TTranslation"];
  content: AST | null;
}

export interface ASTTranslationContext extends BaseAST {
  type: (typeof ASTType)["TTranslationContext"];
  content: AST | null;
  translationCtx: string;
}

export type AST =
  | ASTText
  | ASTDomNode
  | ASTMulti
  | ASTTif
  | ASTTSet
  | ASTTCall
  | ASTTOut
  | ASTTForEach
  | ASTTKey
  | ASTComponent
  | ASTTCallSlot
  | ASTTCallBlock
  | ASTLog
  | ASTDebug
  | ASTTranslation
  | ASTTranslationContext;

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------
const NO_DIRECTIVES = {};
const cache: WeakMap<object, WeakMap<Element, AST>> = new WeakMap();

export function parse(xml: string | Element, customDir?: CustomDirectives): AST {
  // no custom directive and an empty set of them parse alike: one cache
  const customDirectives = customDir && Object.keys(customDir).length ? customDir : undefined;
  const ctx = { inPreTag: false, customDirectives };
  if (typeof xml === "string") {
    const elem = parseXML(`<t>${xml}</t>`).firstChild as Element;
    return _parse(elem, ctx);
  }
  const directivesKey = customDirectives || NO_DIRECTIVES;
  let astCache = cache.get(directivesKey);
  if (!astCache) {
    astCache = new WeakMap();
    cache.set(directivesKey, astCache);
  }
  let ast = astCache.get(xml);
  if (!ast) {
    // we clone here the xml to prevent modifying it in place
    ast = _parse(xml.cloneNode(true) as Element, ctx);
    astCache.set(xml, ast);
  }
  return ast;
}

function _parse(xml: Element, ctx: ParsingContext): AST {
  normalizeXML(xml);
  return parseNode(xml, ctx) || { type: ASTType.Text, value: "" };
}

interface ParsingContext {
  tModelInfo?: TModelInfo | null;
  nameSpace?: string;
  inPreTag: boolean;
  customDirectives?: CustomDirectives;
}

function parseNode(node: Node, ctx: ParsingContext): AST | null {
  if (!(node instanceof Element)) {
    return parseTextCommentNode(node, ctx);
  }
  return (
    parseTCustom(node, ctx) ||
    parseTDebugLog(node, ctx) ||
    parseTForEach(node, ctx) ||
    parseTIf(node, ctx) ||
    parseTTranslation(node, ctx) ||
    parseTTranslationContext(node, ctx) ||
    parseTKey(node, ctx) ||
    parseTCall(node, ctx) ||
    parseTCallBlock(node, ctx) ||
    parseTOutNode(node, ctx) ||
    parseTCallSlot(node, ctx) ||
    parseComponent(node, ctx) ||
    parseDOMNode(node, ctx) ||
    parseTSetNode(node, ctx) ||
    parseTNode(node, ctx)
  );
}

// -----------------------------------------------------------------------------
// <t /> tag
// -----------------------------------------------------------------------------

function isTranslationContext(attribute: string): boolean {
  return attribute === "t-translation-context" || attribute.startsWith(TRANSLATION_CONTEXT_PREFIX);
}

function unsupportedDirectiveError(directive: string, where: string): OwlError {
  return new OwlError(`Unsupported directive '${directive}' on ${where}`);
}

function tRefError(node: Element): OwlError {
  return new OwlError(
    `Directive 't-ref' can only be used on DOM nodes (used on a <${node.tagName}>)`
  );
}

/**
 * The value of the directive `attr` of `node`, which must be an expression
 * when present: an empty one would compile to invalid code.
 */
function exprAttr(node: Element, attr: string): string | null {
  const value = node.getAttribute(attr);
  if (value !== null && !value.trim()) {
    throw emptyExprError(attr, node);
  }
  return value;
}

function emptyExprError(attr: string, node: Element): OwlError {
  return new OwlError(`Directive '${attr}' needs an expression (on a <${node.tagName}>)`);
}

/**
 * Marks `ast` as rendering nothing when the content it wraps renders nothing.
 */
function wrapping<T extends AST>(ast: T, content: AST | null): T {
  if (!content || content.hasNoRepresentation) {
    ast.hasNoRepresentation = true;
  }
  return ast;
}

function isComponentNode(el: Element): boolean {
  const first = el.tagName[0];
  return first === first.toUpperCase() || el.hasAttribute("t-component");
}

const TRANSLATION_CONTEXT_PREFIX = "t-translation-context-";

interface NodeHandlers {
  on: EventHandlers | null;
  translationCtx: Attrs | null;
}

/**
 * Collects the attribute `name` into `found` if it is a translation context
 * (`t-translation-context-<attr>`) or, with `events`, an event handler
 * (`t-on-<event>`), and tells whether it did.
 */
function collectHandler(
  found: NodeHandlers,
  name: string,
  value: string,
  events: boolean = true
): boolean {
  if (name.startsWith(TRANSLATION_CONTEXT_PREFIX)) {
    (found.translationCtx ||= {})[name.slice(TRANSLATION_CONTEXT_PREFIX.length)] = value;
    return true;
  }
  if (events && name.startsWith("t-on-")) {
    (found.on ||= {})[name.slice(5)] = value;
    return true;
  }
  return false;
}

function parseTNode(node: Element, ctx: ParsingContext): AST | null {
  if (node.tagName !== "t") {
    return null;
  }
  if (node.hasAttribute("t-ref")) {
    throw tRefError(node);
  }
  return parseChildNodes(node, ctx);
}

// -----------------------------------------------------------------------------
// Text and Comment Nodes
// -----------------------------------------------------------------------------
const lineBreakRE = /[\r\n]/;
const htmlWhitespaceOnlyRE = /^[ \t\n\r\f]*$/;

function parseTextCommentNode(node: Node, ctx: ParsingContext): AST | null {
  if (node.nodeType === Node.TEXT_NODE) {
    let value = node.textContent || "";
    if (!ctx.inPreTag && lineBreakRE.test(value) && htmlWhitespaceOnlyRE.test(value)) {
      return null;
    }

    return { type: ASTType.Text, value };
  }
  return null;
}

function parseTCustom(node: Element, ctx: ParsingContext): AST | null {
  if (!ctx.customDirectives) {
    return null;
  }
  const nodeAttrsNames = node.getAttributeNames();
  for (let attr of nodeAttrsNames) {
    if (attr === "t-custom" || attr === "t-custom-") {
      throw new OwlError("Missing custom directive name with t-custom directive");
    }
    if (attr.startsWith("t-custom-")) {
      const directiveName = attr.split(".")[0].slice(9);
      const customDirective = ctx.customDirectives[directiveName];
      if (!customDirective) {
        throw new OwlError(`Custom directive "${directiveName}" is not defined`);
      }
      const value = node.getAttribute(attr)!;
      const modifiers = attr.split(".").slice(1);
      node.removeAttribute(attr);
      try {
        customDirective(node, value, modifiers);
      } catch (error) {
        throw new OwlError(
          `Custom directive "${directiveName}" throw the following error: ${error}`
        );
      }
      return parseNode(node, ctx);
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// debugging
// -----------------------------------------------------------------------------

function parseTDebugLog(node: Element, ctx: ParsingContext): AST | null {
  if (node.hasAttribute("t-debug")) {
    node.removeAttribute("t-debug");
    const content = parseNode(node, ctx);
    return wrapping<ASTDebug>({ type: ASTType.TDebug, content }, content);
  }

  if (node.hasAttribute("t-log")) {
    const expr = node.getAttribute("t-log")!;
    node.removeAttribute("t-log");
    const content = parseNode(node, ctx);
    return wrapping<ASTLog>({ type: ASTType.TLog, expr, content }, content);
  }
  return null;
}

// -----------------------------------------------------------------------------
// Regular dom node
// -----------------------------------------------------------------------------
const ROOT_SVG_TAGS = new Set(["svg", "g", "path"]);

const ATT_DIRECTIVE_RE = /^t-att(f?-.+)?$/;
const T_MODEL_MODIFIERS = new Set(["lazy", "trim", "number", "proxy"]);

// the directives whose content renders conditionally, repeatedly or somewhere
// else: a t-set-slot lifted out of it would be defined unconditionally, once
const SLOT_HIDING_DIRECTIVES = new Set([
  "t-if",
  "t-elif",
  "t-else",
  "t-foreach",
  "t-out",
  "t-esc",
  "t-call",
  "t-call-block",
  "t-call-slot",
  "t-slot",
  "t-set",
]);

function parseDOMNode(node: Element, ctx: ParsingContext): AST | null {
  const { tagName } = node;
  const dynamicTag = node.getAttribute("t-tag");
  node.removeAttribute("t-tag");
  if (tagName === "t" && !dynamicTag) {
    return null;
  }
  if (tagName.startsWith("block-")) {
    throw new OwlError(`Invalid tag name: '${tagName}'`);
  }
  ctx = Object.assign({}, ctx);
  if (tagName === "pre") {
    ctx.inPreTag = true;
  }

  let ns = !ctx.nameSpace && ROOT_SVG_TAGS.has(tagName) ? "http://www.w3.org/2000/svg" : null;
  const ref = exprAttr(node, "t-ref");
  node.removeAttribute("t-ref");

  const nodeAttrsNames = node.getAttributeNames();
  let attrs: ASTDomNode["attrs"] = null;
  const handlers: NodeHandlers = { on: null, translationCtx: null };
  let model: TModelInfo | null = null;

  for (let attr of nodeAttrsNames) {
    const value = node.getAttribute(attr)!;
    if (attr === "t-on" || attr === "t-on-") {
      throw new OwlError("Missing event name with t-on directive");
    }
    if (collectHandler(handlers, attr, value)) {
      continue;
    }
    if (attr === "t-model" || attr.startsWith("t-model.")) {
      if (!["input", "select", "textarea"].includes(tagName)) {
        throw new OwlError(
          "The t-model directive only works with <input>, <textarea> and <select>"
        );
      }
      if (!value.trim()) {
        throw emptyExprError(attr, node);
      }
      const typeAttr = node.getAttribute("type");
      const isInput = tagName === "input";
      const isSelect = tagName === "select";
      const isCheckboxInput = isInput && typeAttr === "checkbox";
      const isRadioInput = isInput && typeAttr === "radio";
      const modifiers = attr.split(".").slice(1);
      for (const modifier of modifiers) {
        if (!T_MODEL_MODIFIERS.has(modifier)) {
          throw new OwlError(`Unknown t-model modifier: '${modifier}'`);
        }
      }
      const hasTrimMod = modifiers.includes("trim");
      const hasLazyMod = hasTrimMod || modifiers.includes("lazy");
      const hasNumberMod = modifiers.includes("number");
      const hasProxyMod = modifiers.includes("proxy");
      const eventType = isRadioInput ? "click" : isSelect || hasLazyMod ? "change" : "input";

      model = {
        expr: value,
        targetAttr: isCheckboxInput ? "checked" : "value",
        specialInitTargetAttr: isRadioInput ? "checked" : null,
        eventType,
        hasDynamicChildren: false,
        shouldTrim: hasTrimMod,
        shouldNumberize: hasNumberMod,
        isProxy: hasProxyMod,
      };
      if (isSelect) {
        // ctx is this node's copy: its options see the model
        ctx.tModelInfo = model;
      }
    } else if (attr.startsWith("block-")) {
      throw new OwlError(`Invalid attribute: '${attr}'`);
    } else if (attr === "xmlns") {
      ns = value;
    } else if (attr !== "t-name") {
      if (attr.startsWith("t-")) {
        if (!ATT_DIRECTIVE_RE.test(attr)) {
          if (attr.startsWith("t-custom-") && attr.length > 9) {
            // parseTCustom only runs with a set of custom directives
            throw new OwlError(`Custom directive "${attr.split(".")[0].slice(9)}" is not defined`);
          }
          throw new OwlError(`Unknown QWeb directive: '${attr}'`);
        }
        if (!attr.startsWith("t-attf") && !value.trim()) {
          throw emptyExprError(attr, node);
        }
      }
      const tModel = ctx.tModelInfo;
      if (tModel && ["t-att-value", "t-attf-value"].includes(attr)) {
        tModel.hasDynamicChildren = true;
      }
      attrs = attrs || {};
      attrs[attr] = value;
    }
  }
  if (ns) {
    ctx.nameSpace = ns;
  }

  const children = parseChildren(node, ctx);
  return {
    type: ASTType.DomNode,
    tag: tagName,
    dynamicTag,
    attrs,
    attrsTranslationCtx: handlers.translationCtx,
    on: handlers.on,
    ref,
    content: children,
    model,
    ns,
  };
}

// -----------------------------------------------------------------------------
// t-out
// -----------------------------------------------------------------------------

function parseTOutNode(node: Element, ctx: ParsingContext): AST | null {
  if (!node.hasAttribute("t-out") && !node.hasAttribute("t-esc")) {
    return null;
  }
  if (node.hasAttribute("t-esc")) {
    console.warn(
      `t-esc has been deprecated in favor of t-out. If the value to render is not wrapped by the "markup" function, it will be escaped`
    );
  }
  const expr = exprAttr(node, node.hasAttribute("t-out") ? "t-out" : "t-esc")!;
  node.removeAttribute("t-out");
  node.removeAttribute("t-esc");

  const tOut: ASTTOut = { type: ASTType.TOut, expr, body: null };
  if (node.tagName === "t" && !node.hasAttribute("t-tag")) {
    if (node.hasAttribute("t-ref")) {
      throw tRefError(node);
    }
    // a translation context is no directive: template inheritance adds one
    // for each attribute an extension sets, a t-if included
    const directive = node
      .getAttributeNames()
      .find((a) => a.startsWith("t-") && a !== "t-name" && !isTranslationContext(a));
    if (directive) {
      throw unsupportedDirectiveError(directive, "a <t> with t-out");
    }
    const body = parseChildren(node, ctx);
    tOut.body = body.length ? body : null;
    return tOut;
  }
  const ref = exprAttr(node, "t-ref");
  node.removeAttribute("t-ref");
  const ast = parseNode(node, ctx);
  if (ast?.type !== ASTType.DomNode) {
    throw new OwlError(`t-out cannot be used on a <${node.tagName}> with this combination`);
  }
  tOut.body = ast.content.length ? ast.content : null;
  return {
    ...ast,
    ref,
    content: [tOut],
  };
}

// -----------------------------------------------------------------------------
// t-foreach and t-key
// -----------------------------------------------------------------------------

function parseTForEach(node: Element, ctx: ParsingContext): AST | null {
  if (!node.hasAttribute("t-foreach")) {
    return null;
  }
  const html = node.outerHTML;
  const collection = exprAttr(node, "t-foreach")!;
  node.removeAttribute("t-foreach");
  const elem = node.getAttribute("t-as");
  if (!elem) {
    throw new OwlError(
      `Directive t-foreach should always be used with t-as (expression: t-foreach="${collection}")`
    );
  }
  node.removeAttribute("t-as");
  const key = exprAttr(node, "t-key");
  if (!key) {
    throw new OwlError(
      `"Directive t-foreach should always be used with a t-key!" (expression: t-foreach="${collection}" t-as="${elem}")`
    );
  }
  node.removeAttribute("t-key");
  const memo = exprAttr(node, "t-memo");
  node.removeAttribute("t-memo");
  const body = parseNode(node, ctx);

  if (!body) {
    return null;
  }
  if (memo !== null) {
    // a memoized item keeps its previous vnode without running its body: the
    // child components it rendered are carried over by key, but a slot or a
    // called template may render components another node owns, or that only
    // the called template knows of
    const directive = findNode(body, unvisitable);
    if (body.hasNoRepresentation || directive) {
      throw new OwlError(
        `t-memo needs an item made of elements, text, t-out and components only (expression: t-foreach="${collection}" t-memo="${memo}"${directive ? `, found ${directive}` : ""})`
      );
    }
  }

  // a called template reads the loop variables from the context
  const hasNoTCall = !/\st-call="/.test(html);
  let noFlags = 0;
  if (hasNoTCall && !html.includes(`${elem}_first`)) noFlags |= ForEachNoFlag.First;
  if (hasNoTCall && !html.includes(`${elem}_last`)) noFlags |= ForEachNoFlag.Last;
  if (hasNoTCall && !html.includes(`${elem}_index`)) noFlags |= ForEachNoFlag.Index;
  if (hasNoTCall && !html.includes(`${elem}_value`)) noFlags |= ForEachNoFlag.Value;

  const ast: ASTTForEach = {
    type: ASTType.TForEach,
    collection,
    elem,
    body,
    key,
    noFlags,
  };
  if (memo !== null) {
    ast.memo = memo;
    if (findNode(body, memoizedContent)) {
      ast.memoContent = true;
    }
  }
  return wrapping(ast, body);
}

const UNVISITABLE: Partial<Record<ASTType, string>> = /* @__PURE__ */ unvisitableTypes();

function unvisitableTypes(): Partial<Record<ASTType, string>> {
  return {
    [ASTType.TCall]: "t-call",
    [ASTType.TCallSlot]: "t-slot",
    [ASTType.TCallBlock]: "t-call-block",
  };
}

/**
 * The first AST node in `value` for which `test` returns a name, and that
 * name. It walks every nested object, so that a branch kept outside
 * `content` (t-elif, a t-out or t-set body) is searched too.
 */
function findNode(value: any, test: (ast: AST) => string | null): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (!Array.isArray(value)) {
    const found = typeof value.type === "number" ? test(value) : null;
    if (found) {
      return found;
    }
  }
  for (const key in value) {
    const found = findNode(value[key], test);
    if (found) {
      return found;
    }
  }
  return null;
}

const unvisitable = (ast: AST) => UNVISITABLE[ast.type] || null;
const memoizedContent = (ast: AST) =>
  ast.type === ASTType.TComponent
    ? "a component"
    : ast.type === ASTType.TForEach && ast.memo !== undefined
      ? "a memoized list"
      : null;

function parseTKey(node: Element, ctx: ParsingContext): AST | null {
  if (!node.hasAttribute("t-key")) {
    return null;
  }
  const key = exprAttr(node, "t-key")!;
  node.removeAttribute("t-key");
  const content = parseNode(node, ctx);
  if (!content) {
    return null;
  }
  return wrapping<ASTTKey>({ type: ASTType.TKey, expr: key, content }, content);
}

// -----------------------------------------------------------------------------
// t-call
// -----------------------------------------------------------------------------

function parseTCall(node: Element, ctx: ParsingContext): AST | null {
  if (!node.hasAttribute("t-call")) {
    return null;
  }
  if (node.tagName !== "t") {
    throw new OwlError(
      `Directive 't-call' can only be used on <t> nodes (used on a <${node.tagName}>)`
    );
  }
  const subTemplate = node.getAttribute("t-call")!;
  const context = exprAttr(node, "t-call-context");
  node.removeAttribute("t-call");
  node.removeAttribute("t-call-context");

  let attrs: Attrs | null = null;
  const handlers: NodeHandlers = { on: null, translationCtx: null };
  for (let attributeName of node.getAttributeNames()) {
    const value = node.getAttribute(attributeName)!;
    if (collectHandler(handlers, attributeName, value, false)) {
      continue;
    }
    if (attributeName.startsWith("t-")) {
      throw unsupportedDirectiveError(attributeName, "a t-call node");
    }
    attrs = attrs || {};
    attrs[attributeName] = value;
  }

  const body = parseChildNodes(node, ctx);
  return {
    type: ASTType.TCall,
    name: subTemplate,
    attrs,
    attrsTranslationCtx: handlers.translationCtx,
    body,
    context,
  };
}

// -----------------------------------------------------------------------------
// t-call-block
// -----------------------------------------------------------------------------

function parseTCallBlock(node: Element, ctx: ParsingContext): AST | null {
  if (!node.hasAttribute("t-call-block")) {
    return null;
  }
  const name = exprAttr(node, "t-call-block")!;
  const directive = node
    .getAttributeNames()
    .find((a) => a.startsWith("t-") && a !== "t-call-block" && !isTranslationContext(a));
  if (directive) {
    throw unsupportedDirectiveError(directive, "a t-call-block node");
  }
  return {
    type: ASTType.TCallBlock,
    name,
  };
}

// -----------------------------------------------------------------------------
// t-if
// -----------------------------------------------------------------------------

function parseTIf(node: Element, ctx: ParsingContext): AST | null {
  if (!node.hasAttribute("t-if")) {
    return null;
  }
  const condition = exprAttr(node, "t-if")!;
  node.removeAttribute("t-if");
  const content = parseNode(node, ctx) || { type: ASTType.Text, value: "" };

  let nextElement = node.nextElementSibling;
  // t-elifs
  const tElifs: any[] = [];
  while (nextElement && nextElement.hasAttribute("t-elif")) {
    const condition = exprAttr(nextElement, "t-elif");
    nextElement.removeAttribute("t-elif");
    const tElif = parseNode(nextElement, ctx) || { type: ASTType.Text, value: "" };
    const next = nextElement.nextElementSibling;
    nextElement.remove();
    nextElement = next;
    tElifs.push({ condition, content: tElif });
  }

  // t-else
  let tElse: AST | null = null;
  if (nextElement && nextElement.hasAttribute("t-else")) {
    nextElement.removeAttribute("t-else");
    tElse = parseNode(nextElement, ctx);
    nextElement.remove();
  }

  return {
    type: ASTType.TIf,
    condition,
    content,
    tElif: tElifs.length ? tElifs : null,
    tElse,
  };
}

// -----------------------------------------------------------------------------
// t-set directive
// -----------------------------------------------------------------------------

function parseTSetNode(node: Element, ctx: ParsingContext): AST | null {
  if (!node.hasAttribute("t-set")) {
    return null;
  }
  const name = node.getAttribute("t-set")!;
  const value = node.getAttribute("t-value") || null;
  const isText = [...node.childNodes].every(
    (n) => n.nodeType === Node.TEXT_NODE || n.nodeType === Node.COMMENT_NODE
  );
  let defaultValue: string | null = null;
  let body: AST[] | null = null;
  if (isText) {
    defaultValue = node.textContent || null;
  } else {
    const content = parseChildren(node, ctx);
    body = content.length ? content : null;
  }
  return { type: ASTType.TSet, name, value, defaultValue, body, hasNoRepresentation: true };
}

// -----------------------------------------------------------------------------
// Components
// -----------------------------------------------------------------------------

// Error messages when trying to use an unsupported directive on a component
const directiveErrorMap = new Map([
  [
    "t-ref",
    "t-ref is no longer supported on components. Consider exposing only the public part of the component's API through a callback prop.",
  ],
  ["t-att", "t-att makes no sense on component: props are already treated as expressions"],
  [
    "t-attf",
    "t-attf is not supported on components: use template strings for string interpolation in props",
  ],
]);

function parseComponent(node: Element, ctx: ParsingContext): AST | null {
  let name = node.tagName;
  let isDynamic = node.hasAttribute("t-component");

  if (isDynamic && name !== "t") {
    throw new OwlError(
      `Directive 't-component' can only be used on <t> nodes (used on a <${name}>)`
    );
  }

  if (!isComponentNode(node)) {
    return null;
  }
  if (isDynamic) {
    name = exprAttr(node, "t-component")!;
    node.removeAttribute("t-component");
  }

  const dynamicProps = exprAttr(node, "t-props");
  node.removeAttribute("t-props");

  const defaultSlotScope = node.getAttribute("t-slot-scope");
  node.removeAttribute("t-slot-scope");
  const handlers: NodeHandlers = { on: null, translationCtx: null };
  let props: ASTComponent["props"] = null;
  for (let name of node.getAttributeNames()) {
    const value = node.getAttribute(name)!;
    if (collectHandler(handlers, name, value)) {
      continue;
    }
    if (name.startsWith("t-")) {
      const message = directiveErrorMap.get(name.split("-").slice(0, 2).join("-"));
      throw new OwlError(message || `unsupported directive on Component: ${name}`);
    }
    props = props || {};
    props[name] = value;
  }

  let slots: ASTComponent["slots"] | null = null;
  if (node.hasChildNodes()) {
    const clone = <Element>node.cloneNode(true);

    // named slots
    // the slots of this component, found before any is parsed: parsing a
    // sub component's node takes its directives off
    const slotNodes = Array.from(clone.querySelectorAll("[t-set-slot]")).filter((slotNode) =>
      isOwnSlot(slotNode, clone)
    );
    for (let slotNode of slotNodes) {
      const name = slotNode.getAttribute("t-set-slot")!;
      slotNode.removeAttribute("t-set-slot");
      slotNode.remove();
      const slotHandlers: NodeHandlers = { on: null, translationCtx: null };
      let attrs: Attrs | null = null;
      let scope: string | null = null;
      // a t-set-slot is a <t> (isOwnSlot): the directives of the slot
      // definition go before its content is parsed, as a t-out or a t-call on
      // the same node would reject them
      for (let attributeName of slotNode.getAttributeNames()) {
        const value = slotNode.getAttribute(attributeName)!;
        if (attributeName === "t-slot-scope") {
          scope = value;
        } else if (!collectHandler(slotHandlers, attributeName, value)) {
          continue;
        }
        slotNode.removeAttribute(attributeName);
      }
      const slotAst = parseNode(slotNode, ctx);
      // what the content left are the slot's params
      for (let attributeName of slotNode.getAttributeNames()) {
        attrs = attrs || {};
        attrs[attributeName] = slotNode.getAttribute(attributeName)!;
      }
      slots = slots || {};
      slots[name] = {
        content: slotAst,
        on: slotHandlers.on,
        attrs,
        attrsTranslationCtx: slotHandlers.translationCtx,
        scope,
      };
    }

    // default slot
    const defaultContent = parseChildNodes(clone, ctx);
    slots = slots || {};
    // t-set-slot="default" has priority over content
    if (defaultContent && !slots.default) {
      slots.default = {
        content: defaultContent,
        on: null,
        attrs: null,
        attrsTranslationCtx: null,
        scope: defaultSlotScope,
      };
    }
  }
  return {
    type: ASTType.TComponent,
    name,
    isDynamic,
    dynamicProps,
    props,
    propsTranslationCtx: handlers.translationCtx,
    slots,
    on: handlers.on,
  };
}

/**
 * Whether the t-set-slot `slotNode` defines a slot of the component whose
 * content is `root`, and not of a sub component. Throws where it cannot be
 * one: on an element, nested in another t-set-slot, or under a directive that
 * would make it conditional.
 */
function isOwnSlot(slotNode: Element, root: Element): boolean {
  if (slotNode.tagName !== "t") {
    throw new OwlError(
      `Directive 't-set-slot' can only be used on <t> nodes (used on a <${slotNode.tagName}>)`
    );
  }
  let directiveAbove: string | null = null;
  for (let el = slotNode.parentElement!; el !== root; el = el.parentElement!) {
    if (isComponentNode(el)) {
      return false;
    }
    if (el.hasAttribute("t-set-slot")) {
      throw new OwlError(
        `Directive 't-set-slot' cannot be nested in another t-set-slot (slot "${slotNode.getAttribute("t-set-slot")}" in slot "${el.getAttribute("t-set-slot")}")`
      );
    }
    const directive = el.getAttributeNames().find((a) => SLOT_HIDING_DIRECTIVES.has(a));
    directiveAbove ||= directive ? `${directive} on a <${el.tagName}>` : null;
  }
  if (directiveAbove) {
    // the slot would be lifted out of the directive and always be defined
    throw new OwlError(
      `Directive 't-set-slot' cannot be used under a directive (${directiveAbove}) inside a component`
    );
  }
  return true;
}

// -----------------------------------------------------------------------------
// Slots
// -----------------------------------------------------------------------------

function parseTCallSlot(node: Element, ctx: ParsingContext): AST | null {
  if (!node.hasAttribute("t-call-slot") && !node.hasAttribute("t-slot")) {
    return null;
  }
  if (node.hasAttribute("t-slot")) {
    console.warn(`t-slot has been renamed t-call-slot.`);
  }
  const name = (node.getAttribute("t-call-slot") || node.getAttribute("t-slot"))!;
  node.removeAttribute("t-call-slot");
  node.removeAttribute("t-slot");
  const dynamicProps = exprAttr(node, "t-props");
  node.removeAttribute("t-props");
  let attrs: Attrs | null = null;
  const handlers: NodeHandlers = { on: null, translationCtx: null };
  for (let attributeName of node.getAttributeNames()) {
    const value = node.getAttribute(attributeName)!;
    if (collectHandler(handlers, attributeName, value)) {
      continue;
    }
    if (attributeName.startsWith("t-")) {
      throw unsupportedDirectiveError(attributeName, "a t-call-slot node");
    }
    attrs = attrs || {};
    attrs[attributeName] = value;
  }
  return {
    type: ASTType.TCallSlot,
    name,
    dynamicProps,
    attrs,
    attrsTranslationCtx: handlers.translationCtx,
    on: handlers.on,
    defaultContent: parseChildNodes(node, ctx),
  };
}

// -----------------------------------------------------------------------------
// Translation
// -----------------------------------------------------------------------------

/**
 * Parses `node` without its directive `attr` and wraps what it renders, each
 * part of a multi apart.
 */
function parseWrapped(
  node: Element,
  ctx: ParsingContext,
  attr: string,
  wrap: (content: AST | null) => AST
): AST {
  node.removeAttribute(attr);
  const result = parseNode(node, ctx);
  if (result?.type === ASTType.Multi) {
    return makeASTMulti(result.content.map(wrap));
  }
  return wrap(result);
}

function parseTTranslation(node: Element, ctx: ParsingContext): AST | null {
  if (node.getAttribute("t-translation") !== "off") {
    return null;
  }
  return parseWrapped(node, ctx, "t-translation", (content) =>
    wrapping<ASTTranslation>({ type: ASTType.TTranslation, content }, content)
  );
}

// -----------------------------------------------------------------------------
// Translation Context
// -----------------------------------------------------------------------------

function parseTTranslationContext(node: Element, ctx: ParsingContext): AST | null {
  const translationCtx = node.getAttribute("t-translation-context");
  if (!translationCtx) {
    return null;
  }
  return parseWrapped(node, ctx, "t-translation-context", (content) =>
    wrapping<ASTTranslationContext>(
      { type: ASTType.TTranslationContext, content, translationCtx },
      content
    )
  );
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

/**
 * Parse all the child nodes of a given node and return a list of ast elements
 */
function parseChildren(node: Element, ctx: ParsingContext): AST[] {
  const children: AST[] = [];
  for (let child of node.childNodes) {
    const childAst = parseNode(child, ctx);
    if (childAst) {
      if (childAst.type === ASTType.Multi) {
        children.push(...childAst.content);
      } else {
        children.push(childAst);
      }
    }
  }
  return children;
}

function makeASTMulti(children: AST[]) {
  const ast: ASTMulti = { type: ASTType.Multi, content: children };
  if (children.every((c) => c.hasNoRepresentation)) {
    ast.hasNoRepresentation = true;
  }
  return ast;
}

/**
 * Parse all the child nodes of a given node and return an ast if possible.
 * In the case there are multiple children, they are wrapped in a astmulti.
 */
function parseChildNodes(node: Element, ctx: ParsingContext): AST | null {
  const children = parseChildren(node, ctx);
  switch (children.length) {
    case 0:
      return null;
    case 1:
      return children[0];
    default:
      return makeASTMulti(children);
  }
}

/**
 * Normalizes the content of an Element so that t-if/t-elif/t-else directives
 * immediately follow one another (by removing empty text nodes or comments).
 * Throws an error when a conditional branching statement is malformed. This
 * function modifies the Element in place.
 *
 * @param el the element containing the tree that should be normalized
 */
function normalizeTIf(el: Element) {
  let tbranch = el.querySelectorAll("[t-elif], [t-else]");
  for (let i = 0, ilen = tbranch.length; i < ilen; i++) {
    let node = tbranch[i];
    let prevElem = node.previousElementSibling;
    if (prevElem && (prevElem.hasAttribute("t-if") || prevElem.hasAttribute("t-elif"))) {
      if (prevElem.hasAttribute("t-foreach")) {
        throw new OwlError(
          "t-if cannot stay at the same level as t-foreach when using t-elif or t-else"
        );
      }
      // t-else with a t-if is an else branch holding an `if`: it reads as
      // t-elif, and is what an inheriting template gets when it adds a t-if to
      // an else node, which owl always rendered that way
      const elseIf = node.hasAttribute("t-else") && node.hasAttribute("t-if");
      const branches = ["t-if", "t-elif", "t-else"].filter((a) => node.hasAttribute(a)).length;
      if (!(elseIf && !node.hasAttribute("t-elif")) && branches > 1) {
        throw new OwlError("Only one conditional branching directive is allowed per node");
      }
      // All text (with only spaces) and comment nodes (nodeType 8) between
      // branch nodes are removed
      let textNode;
      while ((textNode = node.previousSibling) !== prevElem) {
        if (textNode!.nodeValue!.trim().length && textNode!.nodeType !== 8) {
          throw new OwlError("text is not allowed between branching directives");
        }
        textNode!.remove();
      }
    } else {
      throw new OwlError(
        "t-elif and t-else directives must be preceded by a t-if or t-elif directive"
      );
    }
  }
}

/**
 * Normalizes the content of an Element so that t-out directives on components
 * are removed and instead places a <t t-out=""> as the default slot of the
 * component. Also throws if the component already has content. This function
 * modifies the Element in place.
 *
 * @param el the element containing the tree that should be normalized
 */
function normalizeTOut(el: Element) {
  const elements = [...el.querySelectorAll(`[t-out], [t-esc]`)].filter(isComponentNode);
  for (const el of elements) {
    if (el.childNodes.length) {
      throw new OwlError(`Cannot have t-out on a component that already has content`);
    }
    const directive = el.hasAttribute("t-out") ? "t-out" : "t-esc";
    const value = el.getAttribute(directive)!;
    el.removeAttribute(directive);
    const t = el.ownerDocument.createElement("t");
    t.setAttribute(directive, value);
    el.appendChild(t);
  }
}

/**
 * Normalizes the tree inside a given element and do some preliminary validation
 * on it. This function modifies the Element in place.
 *
 * @param el the element containing the tree that should be normalized
 */
function normalizeXML(el: Element) {
  normalizeTIf(el);
  normalizeTOut(el);
}
