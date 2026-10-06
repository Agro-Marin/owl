import { EventModifier, OwlError } from "@odoo/owl-core";
import type { CustomDirectives } from ".";
import {
  compileExpr,
  escapeTemplateString,
  interpolate,
  isInterpolated,
  processExpr,
} from "./inline_expressions";
import {
  AST,
  ASTComponent,
  ASTDebug,
  ASTDomNode,
  ASTLog,
  ASTMulti,
  ASTTCall,
  ASTTCallBlock,
  ASTTCallSlot,
  ASTText,
  ASTTForEach,
  ForEachNoFlag,
  ASTTif,
  ASTTKey,
  ASTTOut,
  ASTTranslation,
  ASTTranslationContext,
  ASTTSet,
  ASTType,
  Attrs,
  EventHandlers,
} from "./parser";

const zero = Symbol("zero");
// loop levels whose keys a t-out passes to safeOutput as is (see compileTOut)
const MAX_LAZY_LOOP_KEYS = 3;

type BlockType = "block" | "text" | "multi" | "list" | "html";
// HTML whitespace: a non-breaking space is content, never condensed
const whitespaceRE = /[ \t\n\r\f]+/g;

export interface CompileOptions {
  name?: string;
  dev?: boolean;
  translateFn?: (s: string, translationCtx: string) => string;
  translatableAttributes?: string[];
  customDirectives?: CustomDirectives;
  hasGlobalValues: boolean;
}

// using a non-html document so that <inner/outer>HTML serializes as XML instead
// of HTML (as we will parse it as xml later)
let xmlDoc: Document;
if (typeof document !== "undefined") {
  xmlDoc = document.implementation.createDocument(null, null, null);
}

const MODS = new Set(["stop", "capture", "prevent", "self", "synthetic", "passive"]);

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

/**
 * The key a prop of name `name` takes in a generated object literal.
 */
function propKey(name: string): string {
  return /^[a-z_]+$/i.test(name) ? name : `'${name}'`;
}

/**
 * Returns a template literal that evaluates to str. You can add interpolation
 * sigils into the string if required
 */
function toStringExpression(str: string) {
  return `\`${escapeTemplateString(str)}\``;
}

// -----------------------------------------------------------------------------
// BlockDescription
// -----------------------------------------------------------------------------

class BlockDescription {
  varName: string;
  blockName: string;
  dynamicTagName: string | null = null;
  isRoot: boolean = false;
  hasDynamicChildren: boolean = false;
  children: BlockDescription[] = [];
  data: string[] = [];
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
    // Can't use outerHTML on text nodes
    // append dom to any element and use innerHTML instead
    const t = xmlDoc.createElement("t");
    t.appendChild(this.dom!);
    return t.innerHTML;
  }
}

// -----------------------------------------------------------------------------
// Compiler code
// -----------------------------------------------------------------------------

interface Context {
  block: BlockDescription | null;
  index: number | string;
  forceNewBlock: boolean;
  translate: boolean;
  translationCtx: string;
  tKeyExpr: string | null;
  nameSpace?: string;
  // in a <select t-model> with dynamic options: the model's value, to which
  // an option's value is compared, as a number with .number
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
      nameSpace: parentCtx.nameSpace,
      tModelSelected: parentCtx.tModelSelected,
      inPreTag: parentCtx.inPreTag,
    },
    params
  );
}

class CodeTarget {
  name: string;
  indentLevel = 0;
  loopLevel = 0;
  loopCtxVars: string[] = [];
  // loop levels whose key is concatenated into a string key: they get a
  // `skey<level>` that tells object keys apart
  stringKeyLevels: Set<number> = new Set();
  tSetVars: Map<string, number> = new Map();
  // the loop levels whose item is memoized: a memo hit skips the item's body
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
    if (!this.loopLevel) {
      return ctx.tKeyExpr ? `${ctx.tKeyExpr} + key` : "key";
    }
    if (ctx.tKeyExpr) {
      return `${ctx.tKeyExpr} + ${this.stringKey(this.loopLevel)}`;
    }
    return `key${this.loopLevel}`;
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
  slotNames: Set<String | Symbol> = new Set();
  helpers: Set<string> = new Set();
  // per generator, so that generating a template (a translateFn may compile
  // another) never shifts the names of the one in progress
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
    });
    // define blocks and utility functions
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

    // define all blocks
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
          mainCode.push(`let ${block.blockName} = tag => createBlock(${xmlString});`);
        } else {
          mainCode.push(`let ${block.blockName} = createBlock(${xmlString});`);
        }
      }
    }

    // define all slots/defaultcontent function
    if (this.targets.length) {
      for (let fn of this.targets) {
        mainCode.push("");
        mainCode = mainCode.concat(fn.generateCode());
      }
    }

    // generate main code
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
    this.compileAST(ast, createContext(ctx, { tModelSelected: undefined }));
    this.target = initialTarget;
    return name;
  }

  addLine(line: string, idx?: number) {
    this.target.addLine(line, idx);
  }

  define(varName: string, expr: string) {
    this.addLine(`const ${varName} = ${expr};`);
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

  // a dom block or a list builds its own expression
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

  /**
   * @returns the newly created block name, if any
   */
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

  compileDebug(ast: ASTDebug, ctx: Context): string | null {
    this.addLine(`debugger;`);
    if (ast.content) {
      return this.compileAST(ast.content, ctx);
    }
    return null;
  }

  compileLog(ast: ASTLog, ctx: Context): string | null {
    this.addLine(`console.log(${compileExpr(ast.expr)});`);
    if (ast.content) {
      return this.compileAST(ast.content, ctx);
    }
    return null;
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
    const modifiers = rawEvent.split(".").slice(1);
    const selfIndex = modifiers.indexOf("self");
    let mask = 0;
    modifiers.forEach((m, i) => {
      if (!MODS.has(m)) {
        throw new OwlError(`Unknown event modifier: '${m}'`);
      }
      const beforeSelf = i < selfIndex;
      if (m === "self") {
        mask |= EventModifier.SELF;
      } else if (m === "prevent") {
        mask |= beforeSelf ? EventModifier.PREVENT_ANY : EventModifier.PREVENT;
      } else if (m === "stop") {
        mask |= beforeSelf ? EventModifier.STOP_ANY : EventModifier.STOP;
      }
    });
    const modifiersCode = mask ? `, ${mask}` : "";

    const { expr: compiled, arrow } = processExpr(handler);
    if (!compiled.trim()) {
      return `[null, ctx${modifiersCode}]`;
    }

    let hoistedExpr: string;
    if (arrow) {
      const params = arrow.params ? `ctx,${arrow.params}` : "ctx";
      hoistedExpr = `${arrow.isAsync ? "async " : ""}(${params})=>${arrow.body}`;
    } else {
      this.helpers.add("callHandler");
      hoistedExpr = `(ctx, ev) => callHandler(${compiled}, ctx, ev)`;
    }

    return `[${this.hoistHandler(hoistedExpr)}, ctx${modifiersCode}]`;
  }

  // handlers are static functions of (context, event): one per distinct code
  hoistHandler(expr: string): string {
    let id = this.hoistedHandlers.get(expr);
    if (!id) {
      id = this.generateId("hdlr_fn");
      this.hoistedHandlers.set(expr, id);
      this.staticDefs.push({ id, expr });
    }
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
    // attributes
    const attrs: Attrs = {};
    // the variable holding a dynamic value attribute, for t-model to compare
    let valueVar: string | null = null;

    for (let key in ast.attrs) {
      let expr, attrName;
      if (key.startsWith("t-att")) {
        const isFormat = key.startsWith("t-attf");
        attrName = isFormat ? key.slice(7) : key === "t-att" ? null : key.slice(6);
        expr = isFormat ? interpolate(ast.attrs[key]) : compileExpr(ast.attrs[key]);
        if (attrName && isProp(ast.tag, attrName)) {
          if (attrName === "readonly") {
            // the property has a different name than the attribute
            attrName = "readOnly";
          }
          // we force a new string or new boolean to bypass the equality check in blockdom when patching same value
          if (attrName === "value") {
            const valueId = this.generateId("v");
            this.define(valueId, expr);
            valueVar = valueId;
            // When the expression is falsy (except 0), fall back to an empty string
            expr = `new String(${valueId} === 0 ? 0 : ${valueId} || "")`;
          } else {
            expr = `new Boolean(${expr})`;
          }
          const idx = block!.insertData(expr, "prop");
          attrs[`block-property-${idx}`] = attrName!;
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

    // t-model
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
      let handlerData: string;
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
        handlerData = `[${handlerId}, ctx]`;
      } else {
        const exprId = this.generateId("expr");
        this.helpers.add("modelExpr");
        this.define(exprId, `modelExpr(${compileExpr(expr)})`);
        readExpr = `${exprId}()`;
        // the model is the handler's extra argument: its context stays ctx,
        // whose component must be mounted for the handler to run
        handlerId = this.hoistHandler(`(ctx, ev, model) => model.set(${valueCode})`);
        handlerData = `[${handlerId}, ctx, 0, ${exprId}]`;
      }

      let idx: number;
      if (specialInitTargetAttr) {
        let targetExpr =
          targetAttr in attrs ? JSON.stringify(attrs[targetAttr]) : valueVar || "false";
        if (shouldNumberize) {
          // the handler sets the model to the number of the value
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
      idx = block!.insertData(handlerData, "hdlr");
      attrs[`block-handler-${idx}`] = eventType;
    }

    // event handlers
    for (let ev in ast.on) {
      const name = this.generateHandlerCode(ev, ast.on[ev]);
      const idx = block!.insertData(name, "hdlr");
      attrs[`block-handler-${idx}`] = ev;
    }

    // t-ref
    if (ast.ref) {
      const refExpr = compileExpr(ast.ref);
      this.helpers.add("createRef");
      // `node` is the component that physically hosts this element (for slot
      // content it is the innermost host, threaded through callSlot). createRef
      // registers the ref there so it is cleared if the element is removed
      // without this block's own remove() running (bulk removal).
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
          tKeyExpr: ctx.tKeyExpr,
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
    const isMultiple = this.slotNames.has(zero);
    this.slotNames.add(zero);
    const key = this.scopeKey(ctx, isMultiple);
    let defaultContent = `text("")`;
    if (ast.body) {
      const bodyAst: AST = { type: ASTType.Multi, content: ast.body };
      const name = this.compileInNewTarget("defaultContent", bodyAst, ctx);
      defaultContent = `${name}.call(this, ctx, node, ${key})`;
    }
    return `ctx[zero] ? ctx[zero](node, ${key}) : ${defaultContent}`;
  }

  compileTOut(ast: ASTTOut, ctx: Context): string {
    let { block } = ctx;
    block = this.createBlock(block, "html");
    let blockStr;
    if (ast.expr === "0") {
      blockStr = this.compileZero(ast, ctx);
    } else {
      // the key of this output site: a t-set body (LazyValue) output at several
      // sites, or once per loop iteration, renders its components under each.
      // Only a LazyValue needs it, so its parts are passed and safeOutput joins
      // them only then: the key, the site id, and the raw loop keys
      const site = this.generateId("__");
      const keyExpr = ctx.tKeyExpr ? `${ctx.tKeyExpr} + key` : "key";
      const level = this.target.loopLevel;
      let keyArgs: string;
      if (level <= MAX_LAZY_LOOP_KEYS) {
        if (this.dev) {
          // safeOutput stringifies the loop keys of a LazyValue: the dev duplicate
          // key check must compare that form
          for (let i = 1; i <= level; i++) {
            this.target.stringKey(i);
          }
        }
        const loopKeys = Array.from({ length: level }, (_, i) => `, key${i + 1}`).join("");
        keyArgs = `${keyExpr}, "${site}"${level ? `, ${level}${loopKeys}` : ""}`;
      } else {
        keyArgs = `${this.scopeKey(ctx, false, site)}, ""`;
      }
      const expr = compileExpr(ast.expr);
      if (ast.body) {
        const bodyAst: AST = { type: ASTType.Multi, content: ast.body };
        const name = this.compileInNewTarget("defaultContent", bodyAst, ctx);
        const key = this.scopeKey(ctx, false, site);
        this.helpers.add("safeOutputOr");
        blockStr = `safeOutputOr(${expr}, () => ${name}.call(this, ctx, node, ${key}), ${keyArgs})`;
      } else {
        this.helpers.add("safeOutput");
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
      // one site per list instance: a list inside a loop, or in a template
      // called several times, gets the keys of its position
      memo = this.generateId("memo");
      this.helpers.add("memoPrevious");
      this.helpers.add("memoKeep");
      this.helpers.add("memoHit");
      this.define(`${memo}_site`, this.scopeKey(ctx, true));
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
    // Throw errors on duplicate keys in dev mode
    if (this.dev) {
      this.define(`keys${id}`, `new Set()`);
    }
    this.addLine(`for (let ${loopVar} = 0; ${loopVar} < ${l}; ${loopVar}++) {`);
    this.target.indentLevel++;
    this.addLine(`let ctx = Object.create(${ctxVar});`);
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
    // the body is compiled: whether its keys need the string form is known
    const keyLines: string[] = [];
    let uniqueKey = `key${level}`;
    if (this.target.stringKeyLevels.delete(level)) {
      this.helpers.add("keyOf");
      keyLines.push(`const skey${level} = keyOf(key${level});`);
      uniqueKey = `skey${level}`;
    }
    if (this.dev) {
      // Throw error on duplicate keys in dev mode: two keys are the same when
      // the body's string keys (components, slots, calls) are, even if the
      // list tells them apart
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
        // Check if there are non-DOM directives (like t-set) after the DOM child.
        // If so, defer the return so those directives are compiled before it.
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

    const attrs: string[] = ast.attrs
      ? this.formatPropObject(ast.attrs, ast.attrsTranslationCtx, ctx)
      : [];
    const isDynamic = isInterpolated(ast.name);
    const subTemplate = isDynamic ? interpolate(ast.name) : toStringExpression(ast.name);
    block = this.createBlock(block, "multi");
    if (ast.body) {
      const name = this.compileInNewTarget("callBody", ast.body, ctx);
      const zeroStr = this.generateId("lazyBlock");
      this.define(zeroStr, `${name}.bind(this, ctx)`);
      this.helpers.add("zero");
      attrs.push(`[zero]: ${zeroStr}`);
    } else if (!ast.context) {
      // a call without a body must not let the called template see the 0 of
      // the template that calls it
      this.helpers.add("zero");
      attrs.push(`[zero]: null`);
    }

    let ctxExpr: string;
    const ctxString = `{${attrs.join(", ")}}`;
    if (ast.context) {
      const dynCtxVar = this.generateId("ctx");
      this.addLine(`const ${dynCtxVar} = ${compileExpr(ast.context)};`);
      // the context is the called template's `this`, and its keys are also its
      // variables: Odoo's arch templates read `record`, `__comp__`... by name
      const extra = attrs.length ? `, ${ctxString}` : "";
      ctxExpr = `Object.assign({}, ${dynCtxVar}, {this: ${dynCtxVar}}${extra})`;
    } else {
      ctxExpr = `Object.assign(Object.create(ctx), ${ctxString})`;
    }
    const key = this.scopeKey(ctx, true);
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
    this.insertBlock(block, ctx, compileExpr(ast.name));
    return block.varName;
  }

  compileTSet(ast: ASTTSet, ctx: Context): null {
    let value: string;
    if (ast.body) {
      this.helpers.add("LazyValue");
      const bodyAst: AST = { type: ASTType.Multi, content: ast.body };
      const name = this.compileInNewTarget("value", bodyAst, ctx);
      value = `new LazyValue(${name}, ctx, this, node, ${this.scopeKey(ctx)})`;
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
    } else {
      if (!level) {
        this.target.needsScopeProtection = true;
      }
      this.addLine(`ctx[${name}] = ${value};`);
      this.target.tSetVars.set(ast.name, level);
    }
    return null;
  }

  scopeKey(ctx: Context, unique: boolean = false, site: string = ""): string {
    let suffix = unique ? this.generateId("__") : site;
    for (let i = 1; i <= this.target.loopLevel; i++) {
      suffix += `__\${${this.target.stringKey(i)}}`;
    }
    const key = suffix ? `key + \`${suffix}\`` : "key";
    return ctx.tKeyExpr ? `${ctx.tKeyExpr} + ${key}` : key;
  }

  /**
   * Formats a prop name and value into a string suitable to be inserted in the
   * generated code. For example:
   *
   * Name              Value            Result
   * ---------------------------------------------------------
   * "number"          "state"          "number: ctx['state']"
   * "something"       ""               "something: undefined"
   * "some-prop"       "state"          "'some-prop': ctx['state']"
   * "onClick.bind"    "onClick"        "onClick: bind(ctx, ctx['onClick'])"
   */
  formatProp(
    name: string,
    value: string,
    attrsTranslationCtx: { [name: string]: string } | null,
    ctx: Context
  ): string {
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
    return `${propKey(name)}: ${value || undefined}`;
  }

  formatPropObject(
    obj: { [prop: string]: any },
    attrsTranslationCtx: { [name: string]: string } | null,
    ctx: Context
  ): string[] {
    return Object.entries(obj).map(([k, v]) => this.formatProp(k, v, attrsTranslationCtx, ctx));
  }

  getPropString(props: string[], dynProps: string | null): string {
    let propString = `{${props.join(",")}}`;
    if (dynProps) {
      propString = `Object.assign({}, ${compileExpr(dynProps)}${
        props.length ? ", " + propString : ""
      })`;
    }
    return propString;
  }

  compileComponent(ast: ASTComponent, ctx: Context): string {
    let { block } = ctx;
    // props
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
        // .alike, .bind, .translate — delegate to formatProp, no propList entry
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

    // slots
    let slotDef: string = "";
    if (ast.slots) {
      let slotStr: string[] = [];
      for (let slotName in ast.slots) {
        const slotAst = ast.slots[slotName];
        const params = [];
        if (slotAst.content) {
          const name = this.compileInNewTarget("slot", slotAst.content, ctx, slotAst.on);
          params.push(`__render: ${name}.bind(this), __ctx: ctx`);
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
    }

    if (slotDef && !(ast.dynamicProps || hasSlotsProp)) {
      this.helpers.add("markRaw");
      props.push(`slots: markRaw(${slotDef})`);
    }

    let propString = this.getPropString(props, ast.dynamicProps);

    let propVar: string;
    if ((slotDef && (ast.dynamicProps || hasSlotsProp)) || this.dev) {
      propVar = this.generateId("props");
      this.define(propVar!, propString);
      propString = propVar!;
    }

    if (slotDef && (ast.dynamicProps || hasSlotsProp)) {
      this.helpers.add("markRaw");
      this.addLine(`${propVar!}.slots = markRaw(Object.assign(${slotDef}, ${propVar!}.slots))`);
    }

    // cmap key
    let expr: string;
    if (ast.isDynamic) {
      expr = this.generateId("Comp");
      this.define(expr, compileExpr(ast.name));
    } else {
      expr = `\`${ast.name}\``;
    }

    const keyArg = this.scopeKey(ctx, true);
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

    // a dynamic component's key gets its class's id at run time (createComponent)
    let blockExpr = `${id}(${propString}, ${keyArg}, node, this, ${ast.isDynamic ? expr : null})`;
    if (ast.isDynamic) {
      blockExpr = `toggler(${expr}, ${blockExpr})`;
    }

    // event handling
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
    let handlers: any[] = [];
    for (let ev in on) {
      let handlerId = this.generateId("hdlr");
      let idx = handlers.push(handlerId) - 1;
      spec[ev] = idx;
      const handler = this.generateHandlerCode(ev, on[ev]);
      this.define(handlerId, handler);
    }
    this.staticDefs.push({ id: name, expr: `createCatcher(${JSON.stringify(spec)})` });
    return `${name}(${expr}, [${handlers.join(",")}])`;
  }

  compileTCallSlot(ast: ASTTCallSlot, ctx: Context): string {
    this.helpers.add("callSlot");
    let { block } = ctx;
    let blockString: string;
    let slotName;
    let dynamic = false;
    let isMultiple = false;
    if (isInterpolated(ast.name)) {
      dynamic = true;
      isMultiple = true;
      slotName = interpolate(ast.name);
    } else {
      slotName = JSON.stringify(ast.name);
      isMultiple = isMultiple || this.slotNames.has(ast.name);
      this.slotNames.add(ast.name);
    }
    const attrs = { ...ast.attrs };
    const dynProps = attrs["t-props"];
    delete attrs["t-props"];
    const key = this.scopeKey(ctx, isMultiple);

    const props = ast.attrs ? this.formatPropObject(attrs, ast.attrsTranslationCtx, ctx) : [];
    const scope = this.getPropString(props, dynProps);
    if (ast.defaultContent) {
      const name = this.compileInNewTarget("defaultContent", ast.defaultContent, ctx);
      blockString = `callSlot(ctx, node, ${key}, ${slotName}, ${dynamic}, ${scope}, ${name}.bind(this))`;
    } else {
      if (dynamic) {
        let name = this.generateId("slot");
        this.define(name, slotName);
        blockString = `toggler(${name}, callSlot(ctx, node, ${key}, ${name}, ${dynamic}, ${scope}))`;
      } else {
        blockString = `callSlot(ctx, node, ${key}, ${slotName}, ${dynamic}, ${scope})`;
      }
    }
    // event handling
    if (ast.on) {
      blockString = this.wrapWithEventCatcher(blockString, ast.on);
    }

    block = this.createBlock(block, "multi");
    this.insertBlock(block, ctx, blockString);
    return block.varName;
  }

  compileTTranslation(ast: ASTTranslation, ctx: Context): string | null {
    if (ast.content) {
      return this.compileAST(ast.content, Object.assign({}, ctx, { translate: false }));
    }
    return null;
  }
  compileTTranslationContext(ast: ASTTranslationContext, ctx: Context): string | null {
    if (ast.content) {
      return this.compileAST(
        ast.content,
        Object.assign({}, ctx, { translationCtx: ast.translationCtx })
      );
    }
    return null;
  }
}
