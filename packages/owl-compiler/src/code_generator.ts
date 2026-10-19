import { eventModifierMask, OwlError } from "@odoo/owl-core";
import type { CustomDirectives } from ".";
import {
  compileExpr,
  escapeTemplateString,
  interpolate,
  isInterpolated,
  processExpr,
} from "./inline_expressions";
import {
  type AST,
  type ASTComponent,
  type ASTDebug,
  type ASTDomNode,
  type ASTLog,
  type ASTMulti,
  type ASTTCall,
  type ASTTCallBlock,
  type ASTTCallSlot,
  type ASTText,
  type ASTTForEach,
  ForEachNoFlag,
  type ASTTif,
  type ASTTKey,
  type ASTTOut,
  type ASTTranslation,
  type ASTTranslationContext,
  type ASTTSet,
  ASTType,
  type Attrs,
  type EventHandlers,
} from "./parser";

const SCOPE_MARK = "\u0001scope";
const SCOPE_MARKER_RE = /\u0001scope\d+\u0001/g;
const CAPTURE_MARK = "\u0001capture";
const CAPTURE_MARKER_RE = /\u0001capture\d+\u0001/g;
const CAPTURE_LINE = "\u0001line";
const CONTEXT_WRITE =
  /ctx\['[^']*'\]\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])|ctx\['[^']*'\]\s*(?:\+\+|--)|(?:\+\+|--)\s*ctx\[|delete\s+ctx\[|[[,{:]\s*ctx\['[^']*'\]\s*[,\]}][^;=\n]*?=(?![=>])/;

function readsOf(code: string[]): Set<string> | null {
  const names = new Set<string>();
  for (const line of code) {
    if (line.includes("callTemplate(")) {
      return null;
    }
    for (const match of line.matchAll(CONTEXT_READ)) {
      names.add(match[1]);
    }
  }
  return names;
}
const CONTEXT_READ = /ctx\['([^']*)'\]/g;

const MAX_LAZY_LOOP_KEYS = 3;

const KEY_MARK = "\\u0002";

type BlockType = "block" | "text" | "multi" | "list" | "html";
const whitespaceRE = /[ \t\n\r\f]+/g;

export interface CompileOptions {
  name?: string;
  dev?: boolean;
  translateFn?: (s: string, translationCtx: string) => string;
  translatableAttributes?: string[];
  customDirectives?: CustomDirectives;
  hasGlobalValues: boolean;
}

const xmlDoc: Document = /* @__PURE__ */ makeXmlDocument();

function makeXmlDocument(): Document {
  return typeof document === "undefined"
    ? (undefined as any)
    : document.implementation.createDocument(null, null, null);
}

const LITERAL_RE =
  /^(?:'[^'\\]*'|"[^"\\]*"|`(?:[^`\\]|\\.)*`|-?\d[\d.e+-]*|true|false|null|undefined|\{.*\})$/s;

function isProp(tag: string, key: string): boolean {
  switch (tag) {
    case "input":
      return (
        key === "checked" ||
        key === "indeterminate" ||
        key === "value" ||
        key === "readonly" ||
        key === "readOnly" ||
        key === "disabled"
      );
    case "option":
      return key === "selected" || key === "disabled";
    case "textarea":
      return key === "value" || key === "readonly" || key === "readOnly" || key === "disabled";
    case "select":
      return key === "value" || key === "disabled";
    case "button":
    case "optgroup":
      return key === "disabled";
  }
  return false;
}

function propKey(name: string): string {
  return /^[a-z_]+$/i.test(name) ? name : `'${name}'`;
}

function toStringExpression(str: string) {
  return `\`${escapeTemplateString(str)}\``;
}

class BlockDescription {
  varName: string;
  blockName: string;
  dynamicTagName: string | null = null;
  isRoot: boolean = false;
  hasDynamicChildren: boolean = false;
  children: BlockDescription[] = [];
  data: string[] = [];
  handlers: string[] = [];
  dom?: Node;
  currentDom?: Element;
  target: CodeTarget;
  type: BlockType;
  parentVar: string = "";
  id: number;
  generateId: (prefix?: string) => string;

  constructor(
    id: number,
    target: CodeTarget,
    type: BlockType,
    generateId: (prefix?: string) => string
  ) {
    this.id = id;
    this.generateId = generateId;
    this.varName = "b" + this.id;
    this.blockName = "block" + this.id;
    this.target = target;
    this.type = type;
  }

  insertData(str: string, prefix: string = "d"): number {
    const id = this.generateId(prefix);
    this.target.addLine(`let ${id} = ${str};`);
    return this.data.push(id) - 1;
  }

  insertHandler(fn: string, ctx: string): number {
    this.handlers.push(fn);
    return this.data.push(ctx) - 1;
  }

  insert(dom: Node) {
    if (this.currentDom) {
      this.currentDom.appendChild(dom);
    } else {
      this.dom = dom;
    }
  }

  generateExpr(expr?: string): string {
    if (this.type === "block") {
      const hasChildren = this.children.length;
      let params = this.data.length ? `[${this.data.join(", ")}]` : hasChildren ? "[]" : "";
      if (hasChildren) {
        params += ", [" + this.children.map((c) => c.varName).join(", ") + "]";
      }
      if (this.handlers.length) {
        params += `${hasChildren ? "" : ", null"}, ${this.blockName}_handlers`;
      }
      if (this.dynamicTagName) {
        return `toggler(${this.dynamicTagName}, ${this.blockName}(${this.dynamicTagName})(${params}))`;
      }
      return `${this.blockName}(${params})`;
    } else if (this.type === "list") {
      return `list(c_block${this.id})`;
    }
    return expr!;
  }

  asXmlString() {
    const t = xmlDoc.createElement("t");
    t.appendChild(this.dom!);
    return t.innerHTML;
  }
}

interface Context {
  block: BlockDescription | null;
  index: number | string;
  forceNewBlock: boolean;
  translate: boolean;
  translationCtx: string;
  tKeyExpr: string | null;
  keySegment: string | null;
  nameSpace?: string;
  tModelSelected?: { expr: string; number: boolean };
  inPreTag?: boolean;
}

function createContext(parentCtx: Context, params?: Partial<Context>): Context {
  return Object.assign(
    {
      block: null,
      index: 0,
      forceNewBlock: true,
      translate: parentCtx.translate,
      translationCtx: parentCtx.translationCtx,
      tKeyExpr: null,
      keySegment: parentCtx.keySegment,
      nameSpace: parentCtx.nameSpace,
      tModelSelected: parentCtx.tModelSelected,
      inPreTag: parentCtx.inPreTag,
    },
    params
  );
}

interface LoopScope {
  level: number;
  parentVar: string;
  names: string[];
  parent: LoopScope | null;
}

interface WriteSite {
  name: string;
  seq: number;
  level: number;
  loops: LoopScope[];
}
interface CaptureSite {
  marker: string;
  target: CodeTarget;
  seq: number;
  loops: LoopScope[];
  live: string;
  copy: string;
  helper: string;
  reads: Set<string> | null;
}

interface ScopeSite {
  marker: string;
  target: CodeTarget;
  from: LoopScope;
  itemVar: string;
  varName: string;
  names: string[];
}

class CodeTarget {
  name: string;
  indentLevel = 0;
  loopLevel = 0;
  loopCtxVars: string[] = [];
  loops: LoopScope[] = [];
  writtenLevels: Set<number> = new Set();
  stringKeyLevels: Set<number> = new Set();
  itemKeyLevels: Set<number> = new Set();
  tSetVars: Map<string, number> = new Map();
  seq = 0;
  writes: WriteSite[] = [];
  memoLevels: number[] = [];
  code: string[] = [];
  hasRoot = false;
  deferReturn = false;
  needsScopeProtection = false;
  on: EventHandlers | null;

  constructor(name: string, on?: EventHandlers | null) {
    this.name = name;
    this.on = on || null;
  }

  addLine(line: string, idx?: number) {
    const prefix = new Array(this.indentLevel + 2).join("  ");
    if (idx === undefined) {
      this.code.push(prefix + line);
    } else {
      this.code.splice(idx, 0, prefix + line);
    }
  }

  generateCode(): string {
    let result: string[] = [];
    result.push(`function ${this.name}(ctx, node, key = "") {`);
    if (this.needsScopeProtection) {
      result.push(`  ctx = Object.create(ctx);`);
    }
    for (let line of this.code) {
      result.push(line);
    }
    if (!this.hasRoot) {
      result.push(`return text('');`);
    }
    result.push(`}`);
    return result.join("\n  ");
  }

  currentKey(ctx: Context) {
    if (ctx.tKeyExpr) {
      return `\`\${${this.stringKey(this.loopLevel)}}${ctx.keySegment}\``;
    }
    this.itemKeyLevels.add(this.loopLevel);
    return `ikey${this.loopLevel}`;
  }

  stringKey(level: number): string {
    this.stringKeyLevels.add(level);
    return `skey${level}`;
  }
}

const TRANSLATABLE_ATTRS = [
  "alt",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "label",
  "placeholder",
  "title",
];
const translationRE = /^(\s*)([\s\S]+?)(\s*)$/;

export class CodeGenerator {
  blocks: BlockDescription[] = [];
  scopeSites: ScopeSite[] = [];
  captureSites: CaptureSite[] = [];
  handlerUses: string[] = [];
  isDebug: boolean = false;
  targets: CodeTarget[] = [];
  target = new CodeTarget("template");
  templateName?: string;
  dev: boolean;
  translateFn: (s: string, translationCtx: string) => string;
  translatableAttributes: string[] = TRANSLATABLE_ATTRS;
  ast: AST;
  staticDefs: { id: string; expr: string }[] = [];
  hoistedHandlers: Map<string, string> = new Map();
  helpers: Set<string> = new Set();
  nextBlockId = 1;
  nextDataIds: { [prefix: string]: number } = {};
  generateId = (prefix: string = "") => {
    const n = (this.nextDataIds[prefix] || 0) + 1;
    this.nextDataIds[prefix] = n;
    return prefix + n;
  };
  constructor(ast: AST, options: CompileOptions) {
    this.translateFn = options.translateFn || ((s: string) => s);
    if (options.translatableAttributes) {
      const attrs = new Set(TRANSLATABLE_ATTRS);
      for (let attr of options.translatableAttributes) {
        if (attr.startsWith("-")) {
          attrs.delete(attr.slice(1));
        } else {
          attrs.add(attr);
        }
      }
      this.translatableAttributes = [...attrs];
    }
    this.dev = options.dev || false;
    this.ast = ast;
    this.templateName = options.name;
    if (options.name) {
      const name = options.name.replace(/[^a-zA-Z0-9_$]/g, "_");
      this.target.name = options.name.startsWith("__") ? name : `template_${name}`;
    }
    if (options.hasGlobalValues) {
      this.helpers.add("__globals__");
    }
  }

  generateCode(): string {
    const ast = this.ast;
    this.isDebug = ast.type === ASTType.TDebug;
    this.compileAST(ast, {
      block: null,
      index: 0,
      forceNewBlock: false,
      translate: true,
      translationCtx: "",
      tKeyExpr: null,
      keySegment: null,
    });
    this.resolveCaptures();
    this.resolveScopes();
    let mainCode = [`  let { text, createBlock, list, multi, html, toggler } = bdom;`];
    if (this.helpers.size) {
      mainCode.push(`let { ${[...this.helpers].join(", ")} } = helpers;`);
    }
    if (this.templateName) {
      const name = JSON.stringify(this.templateName).replace(/[\u2028\u2029]/g, " ");
      mainCode.push(`// Template name: ${name}`);
    }

    for (let { id, expr } of this.staticDefs) {
      mainCode.push(`const ${id} = ${expr};`);
    }

    if (this.blocks.length) {
      mainCode.push(``);
      for (let block of this.blocks) {
        let xmlString = toStringExpression(block.asXmlString());
        if (block.dynamicTagName) {
          const name = block.dom!.nodeName;
          const tag = `\${tag || '${name}'}`;
          const close = `</${name}>\``;
          xmlString = `\`<${tag}` + xmlString.slice(`\`<${name}`.length);
          if (xmlString.endsWith(close)) {
            xmlString = xmlString.slice(0, -close.length) + `</${tag}>\``;
          }
          if (block.handlers.length) {
            const types = `${block.blockName}_types`;
            mainCode.push(
              `const ${block.blockName}_handlers = [${block.handlers.join(", ")}];`,
              `const ${types} = Object.create(null);`,
              `let ${block.blockName} = tag => ${types}[tag] || (${types}[tag] = createBlock(${xmlString}, ${block.blockName}_handlers));`
            );
          } else {
            mainCode.push(`let ${block.blockName} = tag => createBlock(${xmlString});`);
          }
        } else {
          let handlers = "";
          if (block.handlers.length) {
            handlers = `, ${block.blockName}_handlers`;
            mainCode.push(`const ${block.blockName}_handlers = [${block.handlers.join(", ")}];`);
          }
          mainCode.push(`let ${block.blockName} = createBlock(${xmlString}${handlers});`);
        }
      }
    }

    if (this.targets.length) {
      for (let fn of this.targets) {
        mainCode.push("");
        mainCode = mainCode.concat(fn.generateCode());
      }
    }

    mainCode.push("");
    mainCode = mainCode.concat("return " + this.target.generateCode());
    const code = mainCode.join("\n  ");

    if (this.isDebug) {
      const msg = `[Owl Debug]\n${code}`;
      console.log(msg);
    }
    return code;
  }

  compileInNewTarget(prefix: string, ast: AST, ctx: Context, on?: EventHandlers | null): string {
    const name = this.generateId(prefix);
    const initialTarget = this.target;
    const target = new CodeTarget(name, on);
    this.targets.push(target);
    this.target = target;
    this.compileAST(ast, createContext(ctx, { tModelSelected: undefined, keySegment: null }));
    this.target = initialTarget;
    return name;
  }

  addLine(line: string, idx?: number) {
    this.target.addLine(line, idx);
  }

  define(varName: string, expr: string) {
    this.addLine(`const ${varName} = ${expr};`);
  }

  scopeMarker(from: LoopScope, itemVar: string, varName: string, names: string[]): string {
    const marker = `${SCOPE_MARK}${this.scopeSites.length}\u0001`;
    this.scopeSites.push({ marker, target: this.target, from, itemVar, varName, names });
    return marker;
  }

  captureMarker(live: string, copy: string, helper: string, reads: Set<string> | null): string {
    const marker = `${CAPTURE_MARK}${this.captureSites.length}\u0001`;
    const target = this.target;
    this.captureSites.push({
      marker,
      target,
      seq: ++target.seq,
      loops: [...target.loops],
      live,
      copy,
      helper,
      reads,
    });
    return marker;
  }

  capturedContext(reads: Set<string> | null): string {
    return this.captureMarker("ctx", "slotContext(ctx)", "slotContext", reads);
  }

  handlerContext(handlerIds: string[]): string {
    const copy = this.generateId("hctx");
    const code = handlerIds.map((id) => this.staticDefs.find((d) => d.id === id)?.expr ?? "");
    const marker = this.captureMarker("ctx", copy, "slotContext", readsOf(code));
    this.addLine(`${marker}${CAPTURE_LINE}const ${copy} = slotContext(ctx);`);
    return marker;
  }

  mark(): [number, number] {
    return [this.targets.length, this.handlerUses.length];
  }

  readsSince([targets, uses]: [number, number]): Set<string> | null {
    return readsOf([
      ...this.targets.slice(targets).flatMap((t) => t.code),
      ...this.handlerUses.slice(uses),
    ]);
  }

  resolveCaptures() {
    const sites = this.captureSites;
    if (!sites.length) {
      return;
    }
    const writes = (w: WriteSite, site: CaptureSite): boolean => {
      const k = w.level;
      if (site.loops.length < k || (k > 0 && site.loops[k - 1] !== w.loops[k - 1])) {
        return false;
      }
      return w.seq > site.seq || (site.loops[k] !== undefined && site.loops[k] === w.loops[k]);
    };
    const resolved = new Map<string, string>();
    for (const site of sites) {
      const copied = site.target.writes.some(
        (w) => (site.reads === null || site.reads.has(w.name)) && writes(w, site)
      );
      if (copied) {
        this.helpers.add(site.helper);
      }
      resolved.set(site.marker, copied ? site.copy : site.live);
    }
    for (const t of [this.target, ...this.targets]) {
      t.code = t.code.flatMap((line) => {
        if (!line.includes(CAPTURE_MARK)) {
          return [line];
        }
        const lineAt = line.indexOf(CAPTURE_LINE);
        if (lineAt !== -1) {
          const marker = line.trimStart().slice(0, line.trimStart().indexOf(CAPTURE_LINE));
          const indent = line.slice(0, line.length - line.trimStart().length);
          return resolved.get(marker) === "ctx"
            ? []
            : [indent + line.slice(lineAt + CAPTURE_LINE.length)];
        }
        return [line.replace(CAPTURE_MARKER_RE, (m) => resolved.get(m)!)];
      });
    }
  }

  resolveScopes() {
    const sites = this.scopeSites;
    if (!sites.length) {
      return;
    }
    const code = [
      ...this.staticDefs.map((d) => d.expr),
      ...[this.target, ...this.targets].flatMap((t) => t.code),
    ].join("\n");
    const writesContext = CONTEXT_WRITE.test(code);
    const copiable = (loop: LoopScope, target: CodeTarget): boolean =>
      !writesContext && !target.writtenLevels.has(loop.level);
    const base = (loop: LoopScope, target: CodeTarget): string =>
      loop.parent && copiable(loop.parent, target) ? base(loop.parent, target) : loop.parentVar;
    const ownNames = (loop: LoopScope, target: CodeTarget): string[] => {
      const names =
        loop.parent && copiable(loop.parent, target) ? ownNames(loop.parent, target) : [];
      return [...new Set([...names, ...loop.names])];
    };
    const resolved = new Map<string, string>();
    for (const { marker, target, from, itemVar, varName, names } of sites) {
      let expr = `Object.create(${itemVar})`;
      if (copiable(from, target)) {
        expr = `Object.create(${base(from, target)})`;
        for (const name of ownNames(from, target)) {
          if (!names.includes(name)) {
            const key = JSON.stringify(name);
            expr += `; ${varName}[${key}] = ${itemVar}[${key}]`;
          }
        }
      }
      resolved.set(marker, expr);
    }
    for (const t of [this.target, ...this.targets]) {
      t.code = t.code.map((line) =>
        line.includes(SCOPE_MARK) ? line.replace(SCOPE_MARKER_RE, (m) => resolved.get(m)!) : line
      );
    }
  }

  insertAnchor(block: BlockDescription) {
    const tag = `block-child-${block.children.length}`;
    const anchor = xmlDoc.createElement(tag);
    block.insert(anchor);
  }

  createBlock(parentBlock: BlockDescription | null, type: BlockType): BlockDescription {
    const hasRoot = this.target.hasRoot;
    const block = new BlockDescription(this.nextBlockId++, this.target, type, this.generateId);
    if (!hasRoot) {
      this.target.hasRoot = true;
      block.isRoot = true;
    }
    if (parentBlock) {
      if (parentBlock.type === "block") {
        this.insertAnchor(parentBlock);
      }
      parentBlock.children.push(block);
      if (parentBlock.type === "list") {
        block.parentVar = `c_block${parentBlock.id}`;
      }
    }
    return block;
  }

  insertBlock(block: BlockDescription, ctx: Context, expression?: string): void {
    let blockExpr = block.generateExpr(expression);
    if (block.parentVar) {
      let key = this.target.currentKey(ctx);
      this.helpers.add("withKey");
      this.addLine(`${block.parentVar}[${ctx.index}] = withKey(${blockExpr}, ${key});`);
      return;
    }

    if (ctx.tKeyExpr) {
      blockExpr = `toggler(${ctx.tKeyExpr}, ${blockExpr})`;
    }

    if (block.isRoot && !this.target.deferReturn) {
      this.emitRootReturn(blockExpr);
    } else {
      this.define(block.varName, blockExpr);
    }
  }

  emitRootReturn(expr: string) {
    if (this.target.on) {
      expr = this.wrapWithEventCatcher(expr, this.target.on);
    }
    this.addLine(`return ${expr};`);
  }

  translate(str: string, translationCtx: string): string {
    if (!str.trim()) {
      return str;
    }
    const match = translationRE.exec(str) as any;
    return match[1] + this.translateFn(match[2], translationCtx) + match[3];
  }

  compileAST(ast: AST, ctx: Context): string | null {
    switch (ast.type) {
      case ASTType.Text:
        return this.compileText(ast, ctx);
      case ASTType.DomNode:
        return this.compileTDomNode(ast, ctx);
      case ASTType.TOut:
        return this.compileTOut(ast, ctx);
      case ASTType.TIf:
        return this.compileTIf(ast, ctx);
      case ASTType.TForEach:
        return this.compileTForeach(ast, ctx);
      case ASTType.TKey:
        return this.compileTKey(ast, ctx);
      case ASTType.Multi:
        return this.compileMulti(ast, ctx);
      case ASTType.TCall:
        return this.compileTCall(ast, ctx);
      case ASTType.TCallBlock:
        return this.compileTCallBlock(ast, ctx);
      case ASTType.TSet:
        return this.compileTSet(ast, ctx);
      case ASTType.TComponent:
        return this.compileComponent(ast, ctx);
      case ASTType.TDebug:
        return this.compileDebug(ast, ctx);
      case ASTType.TLog:
        return this.compileLog(ast, ctx);
      case ASTType.TCallSlot:
        return this.compileTCallSlot(ast, ctx);
      case ASTType.TTranslation:
        return this.compileTTranslation(ast, ctx);
      case ASTType.TTranslationContext:
        return this.compileTTranslationContext(ast, ctx);
    }
  }

  compileContent(content: AST | null, ctx: Context): string | null {
    return content ? this.compileAST(content, ctx) : null;
  }

  compileDebug(ast: ASTDebug, ctx: Context): string | null {
    this.addLine(`debugger;`);
    return this.compileContent(ast.content, ctx);
  }

  compileLog(ast: ASTLog, ctx: Context): string | null {
    this.addLine(`console.log(${compileExpr(ast.expr)});`);
    return this.compileContent(ast.content, ctx);
  }
  compileText(ast: ASTText, ctx: Context): string {
    let { block, forceNewBlock } = ctx;

    let value = ast.value;
    if (value && ctx.translate !== false) {
      value = this.translate(value, ctx.translationCtx);
    }
    if (!ctx.inPreTag) {
      value = value.replace(whitespaceRE, " ");
    }

    if (!block || forceNewBlock) {
      block = this.createBlock(block, "text");
      this.insertBlock(block, ctx, `text(${toStringExpression(value)})`);
    } else {
      block.insert(xmlDoc.createTextNode(value));
    }
    return block.varName;
  }

  generateHandlerCode(rawEvent: string, handler: string): string {
    eventModifierMask(rawEvent);
    const { expr: compiled, arrow } = processExpr(handler);
    if (!compiled.trim()) {
      return "null";
    }

    let hoistedExpr: string;
    if (arrow) {
      const params = arrow.params ? `ctx,${arrow.params}` : "ctx";
      hoistedExpr = `${arrow.isAsync ? "async " : ""}(${params})=>${arrow.body}`;
    } else {
      this.helpers.add("callHandler");
      hoistedExpr = `(ctx, ev) => callHandler(${compiled}, ctx, ev)`;
    }

    return this.hoistHandler(hoistedExpr);
  }

  hoistHandler(expr: string): string {
    let id = this.hoistedHandlers.get(expr);
    if (!id) {
      id = this.generateId("hdlr_fn");
      this.hoistedHandlers.set(expr, id);
      this.staticDefs.push({ id, expr });
    }
    this.handlerUses.push(expr);
    return id;
  }

  compileTDomNode(ast: ASTDomNode, ctx: Context): string {
    let { block, forceNewBlock } = ctx;
    const isNewBlock = !block || forceNewBlock || ast.dynamicTag !== null || ast.ns;
    let codeIdx = this.target.code.length;
    if (isNewBlock) {
      block = this.createBlock(block, "block");
      this.blocks.push(block);
      if (ast.dynamicTag) {
        const tagExpr = this.generateId("tag");
        this.helpers.add("checkTagName");
        this.define(tagExpr, `checkTagName(${compileExpr(ast.dynamicTag)})`);
        block.dynamicTagName = tagExpr;
      }
    }
    const attrs: Attrs = {};
    let valueVar: string | null = null;

    for (let key in ast.attrs) {
      let expr, attrName;
      if (key.startsWith("t-att")) {
        const isFormat = key.startsWith("t-attf");
        attrName = isFormat ? key.slice(7) : key === "t-att" ? null : key.slice(6);
        expr = isFormat ? interpolate(ast.attrs[key]) : compileExpr(ast.attrs[key]);
        if (!attrName) {
          this.helpers.add("attrsValue");
          expr = `attrsValue(${expr})`;
        } else if (!LITERAL_RE.test(expr)) {
          this.helpers.add("attrValue");
          expr = `attrValue(${expr})`;
        }
        if (attrName && isProp(ast.tag, attrName)) {
          if (attrName === "readonly") {
            attrName = "readOnly";
          }
          const idx = block!.insertData(expr, "prop");
          attrs[`block-sync-property-${idx}`] = attrName!;
          if (attrName === "value") {
            valueVar = block!.data[idx];
          }
        } else {
          const idx = block!.insertData(expr, "attr");
          if (key === "t-att") {
            attrs[`block-attributes`] = String(idx);
          } else {
            attrs[`block-attribute-${idx}`] = attrName!;
          }
          if (attrName === "value") {
            valueVar = block!.data[idx];
          }
        }
      } else if (ctx.translate && this.translatableAttributes.includes(key)) {
        const attrTranslationCtx = ast.attrsTranslationCtx?.[key] || ctx.translationCtx;
        attrs[key] = this.translate(ast.attrs[key], attrTranslationCtx);
      } else {
        expr = JSON.stringify(ast.attrs[key]);
        attrName = key;
        attrs[key] = ast.attrs[key];
      }

      if (attrName === "value" && ctx.tModelSelected) {
        const { expr: selected, number } = ctx.tModelSelected;
        const value = key.startsWith("t-att") ? valueVar : expr;
        const target = number ? `toNumber(${value})` : value;
        let selectedId = block!.insertData(`${selected} === ${target}`, "attr");
        attrs[`block-attribute-${selectedId}`] = "selected";
      }
    }

    let tModelSelected: Context["tModelSelected"];
    if (ast.model) {
      const {
        hasDynamicChildren,
        expr,
        eventType,
        shouldNumberize,
        shouldTrim,
        targetAttr,
        specialInitTargetAttr,
        isProxy,
      } = ast.model;

      let readExpr: string;
      let modelId: string | null = null;
      let valueCode = `ev.target.${targetAttr}`;
      valueCode = shouldTrim ? `${valueCode}.trim()` : valueCode;
      if (shouldNumberize) {
        this.helpers.add("toNumber");
        valueCode = `toNumber(${valueCode})`;
      }
      let handlerId: string;
      if (isProxy) {
        readExpr = compileExpr(expr);
        handlerId = this.hoistHandler(`(ctx, ev) => { ${readExpr} = ${valueCode}; }`);
      } else {
        modelId = this.generateId("expr");
        this.helpers.add("modelExpr");
        this.define(modelId, `modelExpr(${compileExpr(expr)})`);
        readExpr = `${modelId}()`;
        handlerId = this.hoistHandler(`(ctx, ev, model) => model.set(${valueCode})`);
      }

      let idx: number;
      if (specialInitTargetAttr) {
        let targetExpr =
          targetAttr in attrs ? JSON.stringify(attrs[targetAttr]) : valueVar || "false";
        if (shouldNumberize) {
          targetExpr = `toNumber(${targetExpr})`;
        }
        idx = block!.insertData(`${readExpr} === ${targetExpr}`, "prop");
        attrs[`block-property-${idx}`] = specialInitTargetAttr;
      } else if (hasDynamicChildren) {
        const bValueId = this.generateId("bValue");
        tModelSelected = { expr: bValueId, number: shouldNumberize };
        this.define(bValueId, readExpr);
      } else {
        idx = block!.insertData(readExpr, "prop");
        attrs[`block-property-${idx}`] = targetAttr;
      }
      idx = block!.insertHandler(handlerId, this.handlerContext([handlerId]));
      attrs[`block-handler-${idx}`] = eventType;
      if (modelId) {
        const argIdx = block!.data.push(modelId) - 1;
        attrs[`block-handler-arg-${argIdx}`] = String(idx);
      }
    }

    for (let ev in ast.on) {
      const handlerId = this.generateHandlerCode(ev, ast.on[ev]);
      const idx = block!.insertHandler(handlerId, this.handlerContext([handlerId]));
      attrs[`block-handler-${idx}`] = ev;
    }

    if (ast.ref) {
      const refExpr = compileExpr(ast.ref);
      this.helpers.add("createRef");
      const setRefStr = `createRef(${refExpr}, node)`;
      const idx = block!.insertData(setRefStr, "ref");
      attrs["block-ref"] = String(idx);
    }

    const nameSpace = ast.ns || ctx.nameSpace;
    const dom = nameSpace
      ? xmlDoc.createElementNS(nameSpace, ast.tag)
      : xmlDoc.createElement(ast.tag);
    for (const [attr, val] of Object.entries(attrs)) {
      if (!(attr === "class" && val === "")) {
        dom.setAttribute(attr, val);
      }
    }
    block!.insert(dom);
    if (ast.content.length) {
      const initialDom = block!.currentDom;
      block!.currentDom = dom;
      const children = ast.content;
      for (let i = 0; i < children.length; i++) {
        const child = ast.content[i];
        const subCtx = createContext(ctx, {
          block,
          forceNewBlock: false,
          nameSpace,
          tModelSelected: tModelSelected || ctx.tModelSelected,
          inPreTag: ctx.inPreTag || ast.tag === "pre",
        });
        this.compileAST(child, subCtx);
      }
      block!.currentDom = initialDom;
    }

    if (isNewBlock) {
      this.insertBlock(block!, ctx);
      if (block!.children.length && block!.hasDynamicChildren) {
        this.hoistChildDeclarations(block!, codeIdx);
      }
    }
    return block!.varName;
  }

  hoistChildDeclarations(block: BlockDescription, codeIdx: number) {
    const code = this.target.code;
    const children = block.children.slice();
    let current = children.shift();
    for (let i = codeIdx; current && i < code.length; i++) {
      if (code[i].trimStart().startsWith(`const ${current.varName} `)) {
        code[i] = code[i].replace(`const ${current.varName}`, current.varName);
        current = children.shift();
      }
    }
    this.addLine(`let ${block.children.map((c) => c.varName).join(", ")};`, codeIdx);
  }

  compileZero(ast: ASTTOut, ctx: Context) {
    this.helpers.add("zero");
    this.helpers.add("zeroCtx");
    const key = this.scopeKey(ctx);
    let defaultContent = `text("")`;
    if (ast.body) {
      const bodyAst: AST = { type: ASTType.Multi, content: ast.body };
      const name = this.compileInNewTarget("defaultContent", bodyAst, ctx);
      defaultContent = `${name}.call(this, ctx, node, ${key})`;
    }
    return `ctx[zero] ? ctx[zero].call(this, ctx[zeroCtx], node, ${key}) : ${defaultContent}`;
  }

  compileTOut(ast: ASTTOut, ctx: Context): string {
    let { block } = ctx;
    block = this.createBlock(block, "html");
    let blockStr;
    if (ast.expr === "0") {
      blockStr = this.compileZero(ast, ctx);
    } else {
      const site = this.siteId();
      const keyExpr = ctx.keySegment ? `key + \`${ctx.keySegment}\`` : "key";
      const level = this.target.loopLevel;
      let keyArgs: string;
      if (level <= MAX_LAZY_LOOP_KEYS) {
        if (this.dev) {
          for (let i = 1; i <= level; i++) {
            this.target.stringKey(i);
          }
        }
        const loopKeys = Array.from({ length: level }, (_, i) => `, key${i + 1}`).join("");
        keyArgs = `node, ${keyExpr}, "${site}"${level ? `, ${level}${loopKeys}` : ""}`;
      } else {
        keyArgs = `node, ${this.scopeKey(ctx, site)}, ""`;
      }
      const expr = compileExpr(ast.expr);
      this.helpers.add("safeOutput");
      if (ast.body) {
        const bodyAst: AST = { type: ASTType.Multi, content: ast.body };
        const name = this.compileInNewTarget("defaultContent", bodyAst, ctx);
        const key = this.scopeKey(ctx, site);
        const value = this.generateId("out");
        this.define(value, expr);
        blockStr =
          `${value} === undefined || ${value} === null ? toggler("default", ${name}.call(this, ctx, node, ${key}))` +
          ` : safeOutput(${value}, ${keyArgs})`;
      } else {
        blockStr = `safeOutput(${expr}, ${keyArgs})`;
      }
    }
    this.insertBlock(block, ctx, blockStr);
    return block.varName;
  }

  compileTIfBranch(content: AST, block: BlockDescription, ctx: Context) {
    this.target.indentLevel++;
    this.compileAST(content, createContext(ctx, { block, index: ctx.index }));
    this.target.indentLevel--;
  }

  compileTIf(ast: ASTTif, ctx: Context): string {
    let { block, forceNewBlock } = ctx;
    const codeIdx = this.target.code.length;
    const isNewBlock = !block || (block.type !== "multi" && forceNewBlock);
    if (block) {
      block.hasDynamicChildren = true;
    }
    block = isNewBlock ? this.createBlock(block, "multi") : block!;
    this.addLine(`if (${compileExpr(ast.condition)}) {`);
    this.compileTIfBranch(ast.content, block, ctx);
    if (ast.tElif) {
      for (let clause of ast.tElif) {
        this.addLine(`} else if (${compileExpr(clause.condition)}) {`);
        this.compileTIfBranch(clause.content, block, ctx);
      }
    }
    if (ast.tElse) {
      this.addLine(`} else {`);
      this.compileTIfBranch(ast.tElse, block, ctx);
    }
    this.addLine("}");
    if (isNewBlock) {
      if (block.children.length) {
        this.hoistChildDeclarations(block, codeIdx);
      }
      const args = block.children.map((c) => c.varName).join(", ");
      this.insertBlock(block, ctx, `multi([${args}])`);
    }
    return block.varName;
  }

  compileTForeach(ast: ASTTForEach, ctx: Context): string | null {
    const block = ast.hasNoRepresentation ? null : this.createBlock(ctx.block, "list");
    const id = block ? block.id : this.generateId("_");
    let memo: string | null = null;
    if (ast.memo !== undefined && block) {
      memo = this.generateId("memo");
      this.helpers.add("memoPrevious");
      this.helpers.add("memoKeep");
      this.helpers.add("memoHit");
      this.define(`${memo}_site`, this.scopeKey(ctx));
      this.define(`${memo}_previous`, `memoPrevious(node, ${memo}_site)`);
      this.define(`${memo}_next`, `new Map()`);
    }
    this.target.loopLevel++;
    const loopVar = `i${this.target.loopLevel}`;
    const ctxVar = this.generateId("ctx");
    this.addLine(`const ${ctxVar} = ctx;`);
    this.target.loopCtxVars.push(ctxVar);
    const vals = `v_block${id}`;
    const keys = `k_block${id}`;
    const l = `l_block${id}`;
    const lists = block ? [keys, vals, l, `c_block${id}`] : [keys, vals, l];
    this.helpers.add("prepareList");
    this.define(`[${lists.join(", ")}]`, `prepareList(${compileExpr(ast.collection)})`);
    if (this.dev) {
      this.define(`keys${id}`, `new Set()`);
    }
    this.addLine(`for (let ${loopVar} = 0; ${loopVar} < ${l}; ${loopVar}++) {`);
    this.target.indentLevel++;
    const suffixes = [""];
    if (!(ast.noFlags & ForEachNoFlag.First)) {
      suffixes.push("_first");
    }
    if (!(ast.noFlags & ForEachNoFlag.Last)) {
      suffixes.push("_last");
    }
    if (!(ast.noFlags & ForEachNoFlag.Index)) {
      suffixes.push("_index");
    }
    if (!(ast.noFlags & ForEachNoFlag.Value)) {
      suffixes.push("_value");
    }
    const parentLoop = this.target.loops[this.target.loops.length - 1] || null;
    const loopScope: LoopScope = {
      level: this.target.loopLevel,
      parentVar: ctxVar,
      names: suffixes.map((suffix) => ast.elem + suffix),
      parent: parentLoop,
    };
    const itemExpr = parentLoop
      ? this.scopeMarker(parentLoop, ctxVar, "ctx", loopScope.names)
      : `Object.create(${ctxVar})`;
    this.addLine(`let ctx = ${itemExpr};`);
    this.target.loops.push(loopScope);
    const loopVarName = (suffix: string) => JSON.stringify(ast.elem + suffix);
    this.addLine(`ctx[${loopVarName("")}] = ${keys}[${loopVar}];`);
    if (!(ast.noFlags & ForEachNoFlag.First)) {
      this.addLine(`ctx[${loopVarName("_first")}] = ${loopVar} === 0;`);
    }
    if (!(ast.noFlags & ForEachNoFlag.Last)) {
      this.addLine(`ctx[${loopVarName("_last")}] = ${loopVar} === ${keys}.length - 1;`);
    }
    if (!(ast.noFlags & ForEachNoFlag.Index)) {
      this.addLine(`ctx[${loopVarName("_index")}] = ${loopVar};`);
    }
    if (!(ast.noFlags & ForEachNoFlag.Value)) {
      this.addLine(`ctx[${loopVarName("_value")}] = ${vals}[${loopVar}];`);
    }
    const level = this.target.loopLevel;
    this.define(`key${level}`, compileExpr(ast.key));
    const keyIdx = this.target.code.length;

    const subCtx = createContext(ctx, { block, index: loopVar });
    if (memo) {
      this.target.memoLevels.push(level);
    }
    this.compileAST(ast.body, subCtx);
    if (memo) {
      this.target.memoLevels.pop();
    }
    const keyLines: string[] = [];
    const itemKeyUsed = this.target.itemKeyLevels.delete(level);
    let uniqueKey = `ikey${level}`;
    if (this.target.stringKeyLevels.delete(level)) {
      this.helpers.add("keyOf");
      keyLines.push(`const skey${level} = keyOf(key${level});`);
      uniqueKey = `skey${level}`;
      if (itemKeyUsed) {
        const itemKeyRE = new RegExp(`\\bikey${level}\\b`, "g");
        const code = this.target.code;
        for (let i = keyIdx; i < code.length; i++) {
          code[i] = code[i].replace(itemKeyRE, uniqueKey);
        }
      }
    } else if (itemKeyUsed || memo || this.dev) {
      this.helpers.add("listKey");
      keyLines.push(`const ikey${level} = listKey(key${level});`);
    }
    if (this.dev) {
      this.helpers.add("OwlError");
      keyLines.push(
        `if (keys${id}.has(${uniqueKey})) { throw new OwlError(\`Got duplicate key in t-foreach: \${key${level}}\`)}`,
        `keys${id}.add(${uniqueKey});`
      );
    }
    if (memo) {
      const vnodes = `c_block${id}`;
      const entry = (content: string) =>
        `{ deps: deps${level}, vnodes: ${vnodes}, index: ${loopVar}, content: ${content} }`;
      keyLines.push(
        `const deps${level} = ${compileExpr(ast.memo!)};`,
        `const hit${level} = memoHit(${memo}_previous, ${uniqueKey}, deps${level}, node);`,
        `if (hit${level} !== undefined) {`,
        `  ${vnodes}[${loopVar}] = hit${level}.vnodes[hit${level}.index];`,
        `  ${memo}_next.set(${uniqueKey}, ${entry(`hit${level}.content`)});`,
        `  continue;`,
        `}`
      );
      if (ast.memoContent) {
        this.helpers.add("memoBegin");
        this.helpers.add("memoEnd");
        keyLines.push(`const outer${level} = memoBegin();`);
        this.addLine(`${memo}_next.set(${uniqueKey}, ${entry(`memoEnd(outer${level})`)});`);
      } else {
        this.addLine(`${memo}_next.set(${uniqueKey}, ${entry("null")});`);
      }
    }
    keyLines.forEach((line, i) => this.addLine(line, keyIdx + i));
    this.target.indentLevel--;
    this.target.loopLevel--;
    this.target.loopCtxVars.pop();
    this.target.loops.pop();
    for (const [name, level] of this.target.tSetVars) {
      if (level > this.target.loopLevel) {
        this.target.tSetVars.delete(name);
      }
    }
    this.addLine(`}`);
    if (memo) {
      this.addLine(`memoKeep(node, ${memo}_site, ${memo}_next);`);
    }
    if (!block) {
      return null;
    }
    this.insertBlock(block, ctx);
    return block.varName;
  }

  compileTKey(ast: ASTTKey, ctx: Context): string | null {
    const tKeyExpr = this.generateId("tKey_");
    this.helpers.add("keyOf");
    this.define(tKeyExpr, `keyOf(${compileExpr(ast.expr)})`);
    ctx = createContext(ctx, {
      tKeyExpr,
      keySegment: `${ctx.keySegment || ""}${KEY_MARK}k\${${tKeyExpr}}`,
      block: ctx.block,
      index: ctx.index,
    });
    return this.compileAST(ast.content, ctx);
  }

  compileMulti(ast: ASTMulti, ctx: Context): string | null {
    let { block, forceNewBlock } = ctx;
    const isNewBlock = !block || forceNewBlock;
    let codeIdx = this.target.code.length;
    if (isNewBlock) {
      const n = ast.content.filter((c) => !c.hasNoRepresentation).length;
      let result: string | null = null;
      if (n <= 1) {
        const shouldDefer =
          !this.target.hasRoot &&
          n === 1 &&
          ast.content[ast.content.length - 1].hasNoRepresentation;
        if (shouldDefer) {
          this.target.deferReturn = true;
        }
        for (let child of ast.content) {
          const blockName = this.compileAST(child, ctx);
          result = result || blockName;
        }
        if (shouldDefer) {
          this.target.deferReturn = false;
          this.emitRootReturn(result!);
        }
        return result;
      }
      block = this.createBlock(block, "multi");
    }
    let index = 0;
    for (let i = 0, l = ast.content.length; i < l; i++) {
      const child = ast.content[i];
      const forceNewBlock = !child.hasNoRepresentation;
      const subCtx = createContext(ctx, {
        block,
        index,
        forceNewBlock,
      });
      this.compileAST(child, subCtx);
      if (forceNewBlock) {
        index++;
      }
    }
    if (isNewBlock) {
      if (block!.hasDynamicChildren && block!.children.length) {
        this.hoistChildDeclarations(block!, codeIdx);
      }
      const args = block!.children.map((c) => c.varName).join(", ");
      this.insertBlock(block!, ctx, `multi([${args}])`);
    }
    return block!.varName;
  }

  compileTCall(ast: ASTTCall, ctx: Context): string {
    let { block } = ctx;

    const attrs = ast.attrs ? this.propEntries(ast.attrs, ast.attrsTranslationCtx, ctx) : [];
    const isDynamic = isInterpolated(ast.name);
    const subTemplate = isDynamic ? interpolate(ast.name) : toStringExpression(ast.name);
    block = this.createBlock(block, "multi");
    const zero: [string, string][] = [];
    if (ast.body) {
      const start = this.mark();
      const name = this.compileInNewTarget("callBody", ast.body, ctx);
      this.helpers.add("zero");
      this.helpers.add("zeroCtx");
      zero.push(["[zero]", name], ["[zeroCtx]", this.capturedContext(this.readsSince(start))]);
    } else if (!ast.context) {
      this.helpers.add("zero");
      zero.push(["[zero]", "null"]);
    }

    let ctxExpr: string;
    if (ast.context) {
      const dynCtxVar = this.generateId("ctx");
      this.addLine(`const ${dynCtxVar} = ${compileExpr(ast.context)};`);
      const entries = [
        `this: ${dynCtxVar}`,
        ...attrs.map(([name, value]) => `${propKey(name)}: ${value}`),
        ...zero.map(([key, value]) => `${key}: ${value}`),
      ];
      ctxExpr = `Object.assign({}, ${dynCtxVar}, {${entries.join(", ")}})`;
    } else if (!attrs.length && !ast.body) {
      this.helpers.add("withoutZero");
      ctxExpr = this.captureMarker(
        "ctx[zero] ? withoutZero(ctx) : ctx",
        "callContext(ctx)",
        "callContext",
        null
      );
    } else {
      ctxExpr = this.generateId("ctx");
      const loop = this.target.loops[this.target.loops.length - 1];
      this.define(
        ctxExpr,
        this.captureMarker(
          loop
            ? this.scopeMarker(loop, "ctx", ctxExpr, [...attrs.map(([name]) => name)])
            : `Object.create(ctx)`,
          "callContext(ctx)",
          "callContext",
          null
        )
      );
      for (const [name, value] of attrs) {
        this.addLine(`${ctxExpr}[${JSON.stringify(name)}] = ${value};`);
      }
      for (const [key, value] of zero) {
        this.addLine(`${ctxExpr}${key} = ${value};`);
      }
    }
    const key = this.scopeKey(ctx);
    this.helpers.add("callTemplate");
    this.insertBlock(
      block,
      ctx,
      `callTemplate(${subTemplate}, this, app, ${ctxExpr}, node, ${key})`
    );
    return block.varName;
  }

  compileTCallBlock(ast: ASTTCallBlock, ctx: Context): string {
    let { block } = ctx;
    block = this.createBlock(block, "multi");
    this.helpers.add("callBlock");
    this.insertBlock(block, ctx, `callBlock(${compileExpr(ast.name)})`);
    return block.varName;
  }

  compileTSet(ast: ASTTSet, ctx: Context): null {
    let value: string;
    if (ast.body) {
      this.helpers.add("LazyValue");
      const bodyAst: AST = { type: ASTType.Multi, content: ast.body };
      const start = this.mark();
      const name = this.compileInNewTarget("value", bodyAst, ctx);
      const kept = this.capturedContext(this.readsSince(start));
      value = `new LazyValue(${name}, ${kept}, this, node, ${this.scopeKey(ctx)})`;
    } else if (ast.defaultValue) {
      value = toStringExpression(
        ctx.translate ? this.translate(ast.defaultValue, ctx.translationCtx) : ast.defaultValue
      );
    } else {
      value = ast.value ? compileExpr(ast.value) : "null";
    }
    if (ast.value && (ast.body || ast.defaultValue)) {
      this.helpers.add("withDefault");
      value = `withDefault(${compileExpr(ast.value)}, ${value})`;
    }

    const name = JSON.stringify(ast.name);
    const level = this.target.loopLevel;
    const defLevel = this.target.tSetVars.get(ast.name);
    if (defLevel !== undefined && level > defLevel) {
      if (this.target.memoLevels.some((memoLevel) => memoLevel > defLevel)) {
        throw new OwlError(
          `t-set="${ast.name}" inside a t-memo item writes a variable of an enclosing scope, and a memo hit would skip the write`
        );
      }
      this.addLine(`${this.target.loopCtxVars[defLevel]}[${name}] = ${value};`);
      this.target.writtenLevels.add(defLevel);
      this.recordWrite(ast.name, defLevel);
    } else {
      if (!level) {
        this.target.needsScopeProtection = true;
      }
      this.addLine(`ctx[${name}] = ${value};`);
      this.target.writtenLevels.add(level);
      this.target.tSetVars.set(ast.name, level);
      this.recordWrite(ast.name, level);
    }
    return null;
  }

  recordWrite(name: string, level: number) {
    const target = this.target;
    target.writes.push({ name, seq: ++target.seq, level, loops: [...target.loops] });
  }

  scopeKey(ctx: Context, site: string = this.siteId()): string {
    let suffix = ctx.keySegment ? `${ctx.keySegment}${site}` : site;
    for (let i = 1; i <= this.target.loopLevel; i++) {
      suffix += `${KEY_MARK}:\${${this.target.stringKey(i)}}`;
    }
    return `key + \`${suffix}\``;
  }

  siteId(): string {
    return this.generateId(KEY_MARK);
  }

  formatProp(
    name: string,
    value: string,
    attrsTranslationCtx: { [name: string]: string } | null,
    ctx: Context
  ): string {
    const [key, code] = this.propEntry(name, value, attrsTranslationCtx, ctx);
    return `${propKey(key)}: ${code}`;
  }

  propEntry(
    name: string,
    value: string,
    attrsTranslationCtx: { [name: string]: string } | null,
    ctx: Context
  ): [string, string] {
    if (name.endsWith(".translate")) {
      const attrTranslationCtx = attrsTranslationCtx?.[name] || ctx.translationCtx;
      value = toStringExpression(ctx.translate ? this.translate(value, attrTranslationCtx) : value);
    } else {
      value = compileExpr(value);
    }
    if (name.includes(".")) {
      let [_name, suffix] = name.split(".");
      name = _name;
      switch (suffix) {
        case "bind":
          value = `(${value}).bind(this)`;
          break;
        case "alike":
        case "translate":
          break;
        default:
          throw new OwlError(`Invalid prop suffix: ${suffix}`);
      }
    }
    return [name, value || "undefined"];
  }

  formatPropObject(
    obj: { [prop: string]: any },
    attrsTranslationCtx: { [name: string]: string } | null,
    ctx: Context
  ): string[] {
    return this.propEntries(obj, attrsTranslationCtx, ctx).map(([k, v]) => `${propKey(k)}: ${v}`);
  }

  propEntries(
    obj: { [prop: string]: any },
    attrsTranslationCtx: { [name: string]: string } | null,
    ctx: Context
  ): [string, string][] {
    return Object.entries(obj).map(([k, v]) => this.propEntry(k, v, attrsTranslationCtx, ctx));
  }

  getPropString(props: string[], dynProps: string | null): string {
    const entries = dynProps ? [`...${compileExpr(dynProps)}`, ...props] : props;
    return `{${entries.join(",")}}`;
  }

  compileComponent(ast: ASTComponent, ctx: Context): string {
    let { block } = ctx;
    const hasSlotsProp = "slots" in (ast.props || {});
    const props: string[] = [];
    const propList: string[] = [];
    const signalProps: string[] = [];

    for (let p in ast.props || {}) {
      let [name, suffix] = p.split(".");

      if (suffix === "signal") {
        props.push(`${propKey(name)}: ${compileExpr(ast.props![p]) || undefined}`);
        signalProps.push(JSON.stringify(name));
        continue;
      }

      if (suffix) {
        props.push(this.formatProp(p, ast.props![p], ast.propsTranslationCtx, ctx));
        continue;
      }

      const { expr: compiledValue, freeVariables } = processExpr(ast.props![p]);

      props.push(`${propKey(name)}: ${compiledValue || undefined}`);

      if (freeVariables) {
        for (const varName of freeVariables) {
          const syntheticKey = `\x01${name}.${varName}`;
          propList.push(`"${syntheticKey}"`);
          props.push(`"${syntheticKey}": ctx['${varName}']`);
        }
      } else {
        propList.push(`"${name}"`);
      }
    }

    let slotDef: string = "";
    if (ast.slots) {
      let slotCtx: string | null = null;
      let slotSite: CaptureSite | null = null;
      const start = this.mark();
      let slotStr: string[] = [];
      for (let slotName in ast.slots) {
        const slotAst = ast.slots[slotName];
        const params = [];
        if (slotAst.content) {
          const name = this.compileInNewTarget("slot", slotAst.content, ctx, slotAst.on);
          if (!slotCtx) {
            slotCtx = this.capturedContext(null);
            slotSite = this.captureSites[this.captureSites.length - 1];
          }
          params.push(`__render: ${name}, __ctx: ${slotCtx}, __owner: this`);
        }
        const scope = ast.slots[slotName].scope;
        if (scope) {
          params.push(`__scope: ${JSON.stringify(scope)}`);
        }
        if (ast.slots[slotName].attrs) {
          params.push(
            ...this.formatPropObject(
              ast.slots[slotName].attrs!,
              ast.slots[slotName].attrsTranslationCtx,
              ctx
            )
          );
        }
        const slotInfo = `{${params.join(", ")}}`;
        slotStr.push(`${JSON.stringify(slotName)}: ${slotInfo}`);
      }
      slotDef = `{${slotStr.join(", ")}}`;
      if (slotSite) {
        slotSite.reads = this.readsSince(start);
      }
    }

    if (slotDef && !(ast.dynamicProps || hasSlotsProp)) {
      props.push(`slots: ${slotDef}`);
    }

    let propString = this.getPropString(props, ast.dynamicProps);

    let propVar: string;
    if ((slotDef && (ast.dynamicProps || hasSlotsProp)) || this.dev) {
      propVar = this.generateId("props");
      this.define(propVar!, propString);
      propString = propVar!;
    }

    if (slotDef && (ast.dynamicProps || hasSlotsProp)) {
      this.addLine(`${propVar!}.slots = Object.assign(${slotDef}, ${propVar!}.slots);`);
    }

    let expr: string;
    if (ast.isDynamic) {
      expr = this.generateId("Comp");
      this.define(expr, compileExpr(ast.name));
    } else {
      expr = `\`${ast.name}\``;
    }

    const keyArg = this.scopeKey(ctx);
    let id = this.generateId("comp");
    this.helpers.add("createComponent");
    this.staticDefs.push({
      id,
      expr: `createComponent(app, ${
        ast.isDynamic ? null : expr
      }, ${!ast.isDynamic}, ${!!ast.slots}, ${!!ast.dynamicProps}, [${propList}]${
        signalProps.length ? `, [${signalProps}]` : ""
      })`,
    });

    let blockExpr = `${id}(${propString}, ${keyArg}, node, this, ${ast.isDynamic ? expr : null})`;
    if (ast.isDynamic) {
      blockExpr = `toggler(${expr}, ${blockExpr})`;
    }

    if (ast.on) {
      blockExpr = this.wrapWithEventCatcher(blockExpr, ast.on);
    }

    block = this.createBlock(block, "multi");
    this.insertBlock(block, ctx, blockExpr);
    return block.varName;
  }

  wrapWithEventCatcher(expr: string, on: EventHandlers): string {
    this.helpers.add("createCatcher");
    let name = this.generateId("catcher");
    let spec: any = {};
    let handlers: string[] = [];
    for (let ev in on) {
      spec[ev] = handlers.push(this.generateHandlerCode(ev, on[ev])) - 1;
    }
    this.staticDefs.push({
      id: name,
      expr: `createCatcher(${JSON.stringify(spec)}, [${handlers.join(", ")}])`,
    });
    return `${name}(${expr}, ${this.capturedContext(readsOf(handlers.map((id) => this.staticDefs.find((d) => d.id === id)?.expr ?? "")))})`;
  }

  compileTCallSlot(ast: ASTTCallSlot, ctx: Context): string {
    this.helpers.add("callSlot");
    let { block } = ctx;
    let blockString: string;
    let slotName;
    let dynamic = false;
    if (isInterpolated(ast.name)) {
      dynamic = true;
      slotName = interpolate(ast.name);
    } else {
      slotName = JSON.stringify(ast.name);
    }
    const key = this.scopeKey(ctx);

    const props = ast.attrs ? this.formatPropObject(ast.attrs, ast.attrsTranslationCtx, ctx) : [];
    const scope =
      props.length || ast.dynamicProps ? this.getPropString(props, ast.dynamicProps) : "null";
    if (ast.defaultContent) {
      const name = this.compileInNewTarget("defaultContent", ast.defaultContent, ctx);
      blockString = `callSlot(ctx, node, ${key}, ${slotName}, ${dynamic}, ${scope}, ${name}, this)`;
    } else {
      if (dynamic) {
        let name = this.generateId("slot");
        this.define(name, slotName);
        blockString = `toggler(${name}, callSlot(ctx, node, ${key}, ${name}, ${dynamic}, ${scope}))`;
      } else {
        blockString = `callSlot(ctx, node, ${key}, ${slotName}, ${dynamic}, ${scope})`;
      }
    }
    if (ast.on) {
      blockString = this.wrapWithEventCatcher(blockString, ast.on);
    }

    block = this.createBlock(block, "multi");
    this.insertBlock(block, ctx, blockString);
    return block.varName;
  }

  compileTTranslation(ast: ASTTranslation, ctx: Context): string | null {
    return this.compileContent(ast.content, { ...ctx, translate: false });
  }

  compileTTranslationContext(ast: ASTTranslationContext, ctx: Context): string | null {
    return this.compileContent(ast.content, { ...ctx, translationCtx: ast.translationCtx });
  }
}
