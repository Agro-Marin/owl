import { OwlError } from "@odoo/owl-core";



const RESERVED_WORDS =   wordSet(
  "true,false,NaN,null,undefined,debugger,console,window,in,instanceof,new,function,return,eval,void,__globals__," +
    "Math,RegExp,Array,Object,Date,Number,Boolean,String,Symbol,BigInt,Map,Set,JSON,Intl,Error," +
    "Infinity,isFinite,isNaN,parseFloat,parseInt,decodeURI,decodeURIComponent,encodeURI,encodeURIComponent"
);

function wordSet(words: string): Set<string> {
  return new Set(words.split(","));
}

const STATEMENT_KEYWORDS =   wordSet(
  "break,case,catch,class,const,continue,default,do,else,enum,export,extends,finally,for,if," +
    "import,super,switch,throw,try,var,while,with,yield"
);

const WORD_REPLACEMENT: { [key: string]: string } =   Object.assign(
  Object.create(null),
  {
    and: "&&",
    or: "||",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  }
);

type TKind =
  | "LEFT_BRACE"
  | "RIGHT_BRACE"
  | "LEFT_BRACKET"
  | "RIGHT_BRACKET"
  | "LEFT_PAREN"
  | "RIGHT_PAREN"
  | "COMMA"
  | "VALUE"
  | "TEMPLATE_STRING"
  | "SYMBOL"
  | "OPERATOR"
  | "COLON";

interface Token {
  type: TKind;
  value: string;
  size?: number;
  varName?: string;
  replace?: Function;
  isLocal?: boolean;
  templateVars?: string[];
  isKeyword?: boolean;
}

const STATIC_TOKEN_MAP: { [key: string]: TKind } =   Object.assign(
  Object.create(null),
  {
    "{": "LEFT_BRACE",
    "}": "RIGHT_BRACE",
    "[": "LEFT_BRACKET",
    "]": "RIGHT_BRACKET",
    ":": "COLON",
    ",": "COMMA",
    "(": "LEFT_PAREN",
    ")": "RIGHT_PAREN",
  }
);

const OPERATORS =
    "...,.,===,==,++,+,!==,!=,!,||,&&,>=,>,<=,<,??=,??,?.,?,--,-,*,/,%,typeof ,delete ,=>,=,;,in ,new ,|,&,^,~".split(
    ","
  );

type Tokenizer = (
  expr: string,
  previous: Token | undefined,
  beforePrevious?: Token | undefined
) => Token | false;

let tokenizeString: Tokenizer = function (expr) {
  let s = expr[0];
  let start = s;
  if (s !== "'" && s !== '"' && s !== "`") {
    return false;
  }
  if (start === "`") {
    const end = findTemplateEnd(expr, 0);
    const value = expr.slice(0, end + 1);
    return {
      type: "TEMPLATE_STRING",
      value,
      replace(replacer: (expr: string) => string) {
        return replaceInterpolations(value, replacer);
      },
    };
  }
  let i = 1;
  let cur;
  while (expr[i] && expr[i] !== start) {
    cur = expr[i];
    s += cur;
    if (cur === "\\") {
      i++;
      cur = expr[i];
      if (!cur) {
        throw new OwlError("Invalid expression");
      }
      s += cur;
    }
    i++;
  }
  if (expr[i] !== start) {
    throw new OwlError("Invalid expression");
  }
  s += start;
  return { type: "VALUE", value: s };
};

function findTemplateEnd(str: string, start: number): number {
  for (let i = start + 1; i < str.length; i++) {
    if (str[i] === "\\") {
      i++;
    } else if (str[i] === "`") {
      return i;
    } else if (str.startsWith("${", i)) {
      i = findClosingBrace(str, i + 2);
    }
  }
  throw new OwlError("Invalid expression");
}

function replaceInterpolations(template: string, replacer: (expr: string) => string): string {
  let result = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "\\") {
      result += template.slice(i, i + 2);
      i += 2;
    } else if (template.startsWith("${", i)) {
      const end = findClosingBrace(template, i + 2);
      result += "${" + replacer(template.slice(i + 2, end)) + "}";
      i = end + 1;
    } else {
      result += template[i++];
    }
  }
  return result;
}

const REGEXP_PREFIX_RE = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEXP_PREFIX_WORDS =   regexpPrefixWords();

function regexpPrefixWords(): Set<string> {
  return new Set([
    "return",
    "void",
    "typeof",
    "delete",
    "in",
    "new",
    ...Object.keys(WORD_REPLACEMENT),
  ]);
}

function startsRegExp(str: string, previous: number): boolean {
  if (previous < 0) {
    return true;
  }
  const char = str[previous];
  if ((char === "+" || char === "-") && str[previous - 1] === char) {
    return false;
  }
  if (REGEXP_PREFIX_RE.test(char)) {
    return true;
  }
  let start = previous + 1;
  while (start > 0 && IDENTIFIER_CHAR_RE.test(str[start - 1])) {
    start--;
  }
  if (!REGEXP_PREFIX_WORDS.has(str.slice(start, previous + 1))) {
    return false;
  }
  let before = start - 1;
  while (before >= 0 && /\s/.test(str[before])) {
    before--;
  }
  return str[before] !== ".";
}

function findClosingBrace(str: string, start: number): number {
  let depth = 0;
  let previous = -1;
  for (let i = start; i < str.length; i++) {
    const char = str[i];
    if (char === "'" || char === '"') {
      for (i++; i < str.length && str[i] !== char; i++) {
        if (str[i] === "\\") {
          i++;
        }
      }
    } else if (char === "`") {
      i = findTemplateEnd(str, i);
    } else if (str.startsWith("/*", i) || str.startsWith("//", i)) {
      i = commentEnd(str, i) - 1;
      continue;
    } else if (char === "/" && startsRegExp(str, previous)) {
      i = regExpEnd(str, i);
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      if (!depth) {
        return i;
      }
      depth--;
    }
    if (!/\s/.test(char)) {
      previous = i;
    }
  }
  throw new OwlError("Invalid expression");
}

function regExpEnd(str: string, start: number): number {
  let inClass = false;
  let i = start + 1;
  for (; str[i] !== "/" || inClass; i++) {
    const char = str[i];
    if (!char || char === "\n") {
      throw new OwlError("Invalid expression");
    }
    if (char === "\\") {
      i++;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    }
  }
  return i;
}

function commentEnd(str: string, start: number): number {
  if (str[start + 1] === "*") {
    const end = str.indexOf("*/", start + 2);
    if (end < 0) {
      throw new OwlError("Invalid expression");
    }
    return end + 2;
  }
  const end = str.indexOf("\n", start);
  return end < 0 ? str.length : end;
}

const NUMBER_RE =
  /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)n?/;

let tokenizeNumber: Tokenizer = function (expr) {
  const match = NUMBER_RE.exec(expr);
  return match ? { type: "VALUE", value: match[0] } : false;
};

const SYMBOL_RE = /^[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*/u;
const IDENTIFIER_CHAR_RE = /[\p{ID_Continue}$\u200C\u200D]/u;

const OBJECT_KEY_END_RE = /^\s*[:,}]/;

let tokenizeSymbol: Tokenizer = function (expr, previous) {
  const match = SYMBOL_RE.exec(expr);
  if (!match) {
    return false;
  }
  const s = match[0];
  const isKey =
    (previous?.type === "LEFT_BRACE" || previous?.type === "COMMA") &&
    OBJECT_KEY_END_RE.test(expr.slice(s.length));
  if (s in WORD_REPLACEMENT && !isKey) {
    return { type: "OPERATOR", value: WORD_REPLACEMENT[s], size: s.length };
  }
  return { type: "SYMBOL", value: s };
};

const OPERAND_PREFIXES = new Set<TKind>([
  "OPERATOR",
  "LEFT_BRACE",
  "LEFT_BRACKET",
  "LEFT_PAREN",
  "COMMA",
  "COLON",
]);

const OPERAND_KEYWORDS = new Set(["void", "return"]);

const tokenizeRegExp: Tokenizer = function (expr, previous, beforePrevious) {
  const afterKeyword =
    previous?.type === "SYMBOL" &&
    OPERAND_KEYWORDS.has(previous.value) &&
    beforePrevious?.value !== "." &&
    beforePrevious?.value !== "?.";
  if (
    expr[0] !== "/" ||
    (previous &&
      !afterKeyword &&
      (!OPERAND_PREFIXES.has(previous.type) || previous.value === "++" || previous.value === "--"))
  ) {
    return false;
  }
  const i = regExpEnd(expr, 0);
  const flags = /^[a-z]*/.exec(expr.slice(i + 1))![0];
  return { type: "VALUE", value: expr.slice(0, i + 1 + flags.length) };
};

const tokenizeStatic: Tokenizer = function (expr) {
  const char = expr[0];
  if (char && char in STATIC_TOKEN_MAP) {
    return { type: STATIC_TOKEN_MAP[char], value: char };
  }
  return false;
};

const tokenizeProperty: Tokenizer = function (expr) {
  const match = SYMBOL_RE.exec(expr);
  return match ? { type: "SYMBOL", value: match[0] } : false;
};

const tokenizeOperator: Tokenizer = function (expr) {
  for (let op of OPERATORS) {
    if (op === "?." && /\d/.test(expr[2])) {
      continue;
    }
    if (op.endsWith(" ")) {
      const word = op.slice(0, -1);
      const next = expr[word.length] || "";
      if (expr.startsWith(word) && !IDENTIFIER_CHAR_RE.test(next)) {
        return next === " "
          ? { type: "OPERATOR", value: op }
          : { type: "OPERATOR", value: op, size: word.length };
      }
    } else if (expr.startsWith(op)) {
      return { type: "OPERATOR", value: op };
    }
  }
  return false;
};

const TOKENIZERS = [
  tokenizeString,
  tokenizeRegExp,
  tokenizeNumber,
  tokenizeOperator,
  tokenizeSymbol,
  tokenizeStatic,
];
const PROPERTY_TOKENIZERS =   [tokenizeProperty].concat(TOKENIZERS);

export function tokenize(expr: string): Token[] {
  const result: Token[] = [];
  let token: boolean | Token = true;
  let error: any;
  let current = expr;

  try {
    while (token) {
      current = current.trim();
      while (current.startsWith("/*") || current.startsWith("//")) {
        current = current.slice(commentEnd(current, 0)).trim();
      }
      if (current) {
        const previous = result[result.length - 1];
        const isProperty = previous?.value === "." || previous?.value === "?.";
        for (let tokenizer of isProperty ? PROPERTY_TOKENIZERS : TOKENIZERS) {
          token = tokenizer(current, previous, result[result.length - 2]);
          if (token) {
            result.push(token);
            current = current.slice(token.size || token.value.length);
            break;
          }
        }
      } else {
        token = false;
      }
    }
  } catch (e) {
    error = e;
  }
  if (current.length || error) {
    throw new OwlError(`Tokenizer error: could not tokenize \`${expr}\``);
  }
  return result;
}


const isLeftSeparator = (token: Token) =>
  token && (token.type === "LEFT_BRACE" || token.type === "COMMA");
const isRightSeparator = (token: Token) =>
  token && (token.type === "RIGHT_BRACE" || token.type === "COMMA");

const paddedValues = new Map([
  ["in ", " in "],
  ["instanceof", " instanceof "],
  ["void", "void "],
]);

function render(tokens: Token[]): string {
  let code = "";
  for (const t of tokens) {
    const value = t.isKeyword ? t.value + " " : paddedValues.get(t.value) || t.value;
    const last = code[code.length - 1];
    if (
      ((last === "+" || last === "-") && value[0] === last) ||
      (last && IDENTIFIER_CHAR_RE.test(last) && IDENTIFIER_CHAR_RE.test(value[0]))
    ) {
      code += " ";
    }
    code += value;
  }
  return code;
}

interface ProcessedExpr {
  expr: string;
  freeVariables: string[] | null;
  variables: string[];
  arrow: { isAsync: boolean; params: string; body: string } | null;
}

const LEFT_GROUPS = new Set<TKind>(["LEFT_BRACE", "LEFT_BRACKET", "LEFT_PAREN"]);
const RIGHT_GROUPS = new Set<TKind>(["RIGHT_BRACE", "RIGHT_BRACKET", "RIGHT_PAREN"]);

function bindArrowParams(tokens: Token[], end: number, scope: Set<string>): number {
  let depth = 0;
  let start = end;
  for (; start >= 0; start--) {
    const type = tokens[start].type;
    if (RIGHT_GROUPS.has(type)) {
      depth++;
    } else if (LEFT_GROUPS.has(type) && !--depth) {
      break;
    }
  }
  bindPattern(tokens, start, scope);
  for (let k = start + 1; k < end; k++) {
    const t = tokens[k];
    if (t.type === "SYMBOL" && t.varName && scope.has(t.varName)) {
      t.value = `_${t.varName}`;
      t.isLocal = true;
    }
  }
  return start;
}

const DECLARATION_KEYWORDS = new Set(["const", "let", "var"]);

function bindBlockDeclarations(tokens: Token[], start: number, scope: Set<string>) {
  let depth = 0;
  for (let k = start + 1; k < tokens.length && depth >= 0; k++) {
    const t = tokens[k];
    if (LEFT_GROUPS.has(t.type)) {
      depth++;
    } else if (RIGHT_GROUPS.has(t.type)) {
      depth--;
    } else if (
      !depth &&
      t.type === "SYMBOL" &&
      DECLARATION_KEYWORDS.has(t.value) &&
      (tokens[k + 1]?.type === "SYMBOL" ||
        tokens[k + 1]?.type === "LEFT_BRACE" ||
        tokens[k + 1]?.type === "LEFT_BRACKET")
    ) {
      t.isKeyword = true;
      k = bindDeclarators(tokens, k + 1, scope);
    }
  }
}

function bindDeclarators(tokens: Token[], start: number, scope: Set<string>): number {
  let depth = 0;
  let inValue = false;
  let k = start;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (LEFT_GROUPS.has(t.type)) {
      if (!depth && !inValue) {
        k = bindPattern(tokens, k, scope);
      } else {
        depth++;
      }
    } else if (RIGHT_GROUPS.has(t.type)) {
      if (!depth--) {
        return k - 1;
      }
    } else if (depth) {
      continue;
    } else if (t.type === "COMMA") {
      inValue = false;
    } else if (t.type === "OPERATOR" && t.value === "=") {
      inValue = true;
    } else if (t.type === "OPERATOR" && t.value === ";") {
      return k;
    } else if (t.type === "SYMBOL" && !inValue) {
      scope.add(t.value);
    }
  }
  return k;
}

function bindPattern(tokens: Token[], start: number, scope: Set<string>): number {
  const levels: { inExpr: boolean; base: boolean; isObject: boolean }[] = [];
  let k = start;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    const level = levels[levels.length - 1];
    if (LEFT_GROUPS.has(t.type)) {
      const prev = tokens[k - 1]?.type;
      const inExpr =
        !!level &&
        (level.inExpr || (level.isObject && (prev === "LEFT_BRACE" || prev === "COMMA")));
      levels.push({ inExpr, base: inExpr, isObject: t.type === "LEFT_BRACE" });
    } else if (RIGHT_GROUPS.has(t.type)) {
      levels.pop();
      if (!levels.length) {
        return k;
      }
    } else if (t.type === "COMMA") {
      level.inExpr = level.base;
    } else if (t.type === "OPERATOR" && t.value === "=") {
      level.inExpr = true;
    } else if (
      t.type === "SYMBOL" &&
      !level.inExpr &&
      tokens[k + 1]?.type !== "COLON" &&
      tokens[k - 1].value !== "." &&
      tokens[k - 1].value !== "?."
    ) {
      scope.add(t.varName ?? t.value);
    }
  }
  return k;
}

function isAsyncArrow(tokens: Token[], i: number): boolean {
  const prev = tokens[i - 1];
  if (prev?.type === "OPERATOR" && (prev.value === "." || prev.value === "?.")) {
    return false;
  }
  let next = i + 1;
  if (tokens[next]?.type === "LEFT_PAREN") {
    let depth = 0;
    for (; next < tokens.length; next++) {
      const type = tokens[next].type;
      if (LEFT_GROUPS.has(type)) {
        depth++;
      } else if (RIGHT_GROUPS.has(type) && !--depth) {
        break;
      }
    }
  } else if (tokens[next]?.type !== "SYMBOL") {
    return false;
  }
  const arrow = tokens[next + 1];
  return arrow?.type === "OPERATOR" && arrow.value === "=>";
}

function collectVariables(tokens: Token[], start: number): string[] {
  const vars = new Set<string>();
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.varName && !t.isLocal) {
      vars.add(t.varName);
    }
    for (const v of t.templateVars || []) {
      vars.add(v);
    }
  }
  return [...vars];
}

export function processExpr(
  expr: string,
  seededLocals?: Set<string>,
  inAsyncArrow: boolean = false
): ProcessedExpr {
  const scopeStack: { vars: Set<string>; depth: number; ternaries: number; isAsync?: boolean }[] =
    [];

  if (seededLocals?.size || inAsyncArrow) {
    scopeStack.push({
      vars: seededLocals || new Set(),
      depth: -Infinity,
      ternaries: 0,
      isAsync: inAsyncArrow,
    });
  }

  const tokens = tokenize(expr);
  let i = 0;
  const stack: (TKind | "BLOCK")[] = [];
  let topLevelArrowIndex = -1;
  let topLevelParams: [number, number] | null = null;

  function isLocal(name: string) {
    return scopeStack.some((s) => s.vars.has(name));
  }

  function innermostScopeAtDepth() {
    const scope = scopeStack[scopeStack.length - 1];
    return scope && scope.depth === stack.length ? scope : null;
  }

  while (i < tokens.length) {
    let token = tokens[i];
    let prevToken = tokens[i - 1];
    let nextToken = tokens[i + 1];
    let groupType = stack[stack.length - 1];

    switch (token.type) {
      case "LEFT_BRACE":
        if (prevToken?.value === "=>") {
          stack.push("BLOCK");
          const scope = scopeStack[scopeStack.length - 1];
          if (scope) {
            bindBlockDeclarations(tokens, i, scope.vars);
          }
        } else {
          stack.push(token.type);
        }
        break;
      case "LEFT_BRACKET":
      case "LEFT_PAREN":
        stack.push(token.type);
        break;
      case "RIGHT_BRACE":
      case "RIGHT_BRACKET":
      case "RIGHT_PAREN":
        stack.pop();
        while (scopeStack.length > 0 && stack.length < scopeStack[scopeStack.length - 1].depth) {
          scopeStack.pop();
        }
        break;
      case "COMMA":
        while (innermostScopeAtDepth()) {
          scopeStack.pop();
        }
        break;
      case "COLON": {
        let scope;
        while ((scope = innermostScopeAtDepth())) {
          if (scope.ternaries) {
            scope.ternaries--;
            break;
          }
          scopeStack.pop();
        }
        break;
      }
      case "OPERATOR":
        if (token.value === ";") {
          while (innermostScopeAtDepth()) {
            scopeStack.pop();
          }
        } else if (token.value === "?") {
          const scope = innermostScopeAtDepth();
          if (scope) {
            scope.ternaries++;
          }
        }
        break;
    }

    if (token.type === "SYMBOL") {
      if (token.value === "async") {
        token.isKeyword = isAsyncArrow(tokens, i);
      } else if (token.value === "await") {
        token.isKeyword = !!scopeStack[scopeStack.length - 1]?.isAsync;
      }
    }
    let isVar = token.type === "SYMBOL" && !token.isKeyword && !RESERVED_WORDS.has(token.value);
    if (isVar) {
      if (prevToken) {
        if (
          groupType === "LEFT_BRACE" &&
          isLeftSeparator(prevToken) &&
          (isRightSeparator(nextToken) ||
            (nextToken?.type === "OPERATOR" && nextToken.value === "="))
        ) {
          tokens.splice(i + 1, 0, { type: "COLON", value: ":" }, { ...token });
          nextToken = tokens[i + 1];
        }

        if (
          prevToken.type === "OPERATOR" &&
          (prevToken.value === "." || prevToken.value === "?.")
        ) {
          isVar = false;
        } else if (prevToken.type === "LEFT_BRACE" || prevToken.type === "COMMA") {
          if (nextToken && nextToken.type === "COLON") {
            isVar = false;
          }
        }
      }
      const startsStatement =
        groupType === "BLOCK" &&
        (prevToken.type === "LEFT_BRACE" ||
          prevToken.type === "RIGHT_BRACE" ||
          prevToken.value === ";");
      if (isVar && startsStatement && STATEMENT_KEYWORDS.has(token.value)) {
        throw new OwlError(
          `Unsupported statement '${token.value}' in a template expression (\`${expr}\`): an arrow function's block body takes declarations, expressions and return only`
        );
      }
    }

    if (token.type === "TEMPLATE_STRING") {
      const currentLocals = new Set<string>();
      for (const scope of scopeStack) {
        for (const v of scope.vars) currentLocals.add(v);
      }
      const templateVars: string[] = [];
      token.value = token.replace!((expr: any) => {
        const isAsync = !!scopeStack[scopeStack.length - 1]?.isAsync;
        const processed = processExpr(expr, currentLocals, isAsync);
        templateVars.push(...processed.variables);
        return processed.expr;
      });
      token.templateVars = templateVars;
    }

    if (nextToken && nextToken.type === "OPERATOR" && nextToken.value === "=>") {
      const newScope = new Set<string>();
      let paramStart = i;
      let params: [number, number] = [i, i + 1];
      if (token.type === "RIGHT_PAREN") {
        paramStart = bindArrowParams(tokens, i, newScope);
        params = [paramStart + 1, i];
      } else {
        newScope.add(token.value);
      }
      const isAsync = !!tokens[paramStart - 1]?.isKeyword;
      if (paramStart === 0 || (paramStart === 1 && isAsync)) {
        topLevelArrowIndex = i + 1;
        topLevelParams = params;
      }
      scopeStack.push({ vars: newScope, depth: stack.length, ternaries: 0, isAsync });
    }

    if (isVar) {
      token.varName = token.value;
      if (!isLocal(token.value)) {
        token.value = `ctx['${token.value}']`;
      } else {
        token.value = `_${token.value}`;
        token.isLocal = true;
      }
    }
    i++;
  }

  const freeVariables =
    topLevelArrowIndex === -1
      ? null
      : collectVariables(tokens, topLevelParams![0]).filter((v) => v !== "this");

  const arrow =
    topLevelArrowIndex === -1
      ? null
      : {
          isAsync: !!tokens[0].isKeyword,
          params: render(tokens.slice(...topLevelParams!)),
          body: render(tokens.slice(topLevelArrowIndex + 1)),
        };
  return {
    expr: render(tokens),
    freeVariables,
    variables: collectVariables(tokens, 0),
    arrow,
  };
}

export function compileExpr(expr: string): string {
  return processExpr(expr).expr;
}

function findInterpolations(s: string): { start: number; end: number; expr: string }[] {
  const result = [];
  for (let i = 0; i < s.length; i++) {
    const isDouble = s.startsWith("{{", i);
    if (!isDouble && !s.startsWith("#{", i)) {
      continue;
    }
    let close: number;
    try {
      close = findClosingBrace(s, i + 2);
    } catch {
      continue;
    }
    if (isDouble && s[close + 1] !== "}") {
      continue;
    }
    const end = isDouble ? close + 2 : close + 1;
    result.push({ start: i, end, expr: s.slice(i + 2, close) });
    i = end - 1;
  }
  return result;
}

export function isInterpolated(s: string): boolean {
  return findInterpolations(s).length > 0;
}

export function escapeTemplateString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

export function interpolate(s: string): string {
  const parts = findInterpolations(s);
  if (parts.length === 1 && parts[0].start === 0 && parts[0].end === s.length) {
    return `(${compileExpr(parts[0].expr)})`;
  }
  let r = "";
  let last = 0;
  for (const { start, end, expr } of parts) {
    r += escapeTemplateString(s.slice(last, start)) + "${" + compileExpr(expr) + "}";
    last = end;
  }
  return "`" + r + escapeTemplateString(s.slice(last)) + "`";
}
