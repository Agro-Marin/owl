import { OwlError } from "@odoo/owl-core";

/**
 * Owl QWeb Expression Parser
 *
 * Owl needs in various contexts to be able to understand the structure of a
 * string representing a javascript expression.  The usual goal is to be able
 * to rewrite some variables.  For example, if a template has
 *
 *  ```xml
 *  <t t-if="computeSomething({val: state.val})">...</t>
 * ```
 *
 * this needs to be translated in something like this:
 *
 * ```js
 *   if (context["computeSomething"]({val: context["state"].val})) { ... }
 * ```
 *
 * This file contains the implementation of an extremely naive tokenizer/parser
 * and evaluator for javascript expressions.  The supported grammar is basically
 * only expressive enough to understand the shape of objects, of arrays, and
 * various operators.
 */

//------------------------------------------------------------------------------
// Misc types, constants and helpers
//------------------------------------------------------------------------------

// the names an expression reads as JavaScript's own, never from the
// context: keywords, and the standard globals a template may call (Vue's
// template allow-list) — a template writing `String(x)` means the global
const RESERVED_WORDS = new Set(
  (
    "true,false,NaN,null,undefined,debugger,console,window,in,instanceof,new,function,return,eval,void,__globals__," +
    "Math,RegExp,Array,Object,Date,Number,Boolean,String,Symbol,BigInt,Map,Set,JSON,Intl,Error," +
    "Infinity,isFinite,isNaN,parseFloat,parseInt,decodeURI,decodeURIComponent,encodeURI,encodeURIComponent"
  ).split(",")
);

// the keywords that start a statement an arrow's block body cannot hold: it
// takes declarations, expressions and return only
const STATEMENT_KEYWORDS = new Set(
  (
    "break,case,catch,class,const,continue,default,do,else,enum,export,extends,finally,for,if," +
    "import,super,switch,throw,try,var,while,with,yield"
  ).split(",")
);

const WORD_REPLACEMENT: { [key: string]: string } = Object.assign(Object.create(null), {
  and: "&&",
  or: "||",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
});

//------------------------------------------------------------------------------
// Tokenizer
//------------------------------------------------------------------------------
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
  // `async` before an arrow, `await` in an async arrow's body, `const`, `let`
  // or `var` in an arrow's block body
  isKeyword?: boolean;
}

const STATIC_TOKEN_MAP: { [key: string]: TKind } = Object.assign(Object.create(null), {
  "{": "LEFT_BRACE",
  "}": "RIGHT_BRACE",
  "[": "LEFT_BRACKET",
  "]": "RIGHT_BRACKET",
  ":": "COLON",
  ",": "COMMA",
  "(": "LEFT_PAREN",
  ")": "RIGHT_PAREN",
});

// the space after a word operator is relevant: the formatted expression keeps
// one after it
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

/**
 * Returns the index of the backtick that closes the template literal opened at
 * `start`, past the interpolations, which may hold template literals themselves.
 */
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

// the characters after which a / starts a regular expression, not a division
const REGEXP_PREFIX_RE = /[(,=:[!&|?{};+\-*%<>~^]/;
// the words after which the tokenizer reads a / as a regular expression: the
// keywords an operand follows and the word operators
const REGEXP_PREFIX_WORDS = new Set([
  "return",
  "void",
  "typeof",
  "delete",
  "in",
  "new",
  ...Object.keys(WORD_REPLACEMENT),
]);

/**
 * Whether a / after the code character at `previous` (-1: none) starts a
 * regular expression, as the tokenizer decides it: after an operator or an
 * opening, but not after a ++ or a --, and after a keyword or word operator
 * that is not a property name.
 */
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

/**
 * Returns the index of the } that closes the code starting at `start`, past
 * the strings, template literals, regular expressions and comments in it.
 */
function findClosingBrace(str: string, start: number): number {
  let depth = 0;
  // the index of the last character of code, for a / to tell a division from
  // a regexp
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

/**
 * Returns the index of the / that closes the regular expression opened at
 * `start`, past its escapes and character classes.
 */
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

/**
 * Returns the index past the comment (`/* *\/` or `//` up to the line end)
 * that starts at `start`.
 */
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
  // a word operator in key position ({gt: 1}, {and}) is a key
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

// the keywords an operand follows: `void /x/` is a regular expression, but
// `a.void / 2` a division
const OPERAND_KEYWORDS = new Set(["void", "return"]);

// a / where an operand is expected starts a regular expression literal; after
// a ++ or a --, which a regular expression cannot follow, it is a division
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
      // a?.5:1 is a ternary
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
const PROPERTY_TOKENIZERS = [tokenizeProperty, ...TOKENIZERS];

/**
 * Convert a javascript expression (as a string) into a list of tokens. For
 * example: `tokenize("1 + b")` will return:
 * ```js
 *  [
 *   {type: "VALUE", value: "1"},
 *   {type: "OPERATOR", value: "+"},
 *   {type: "SYMBOL", value: "b"}
 * ]
 * ```
 */
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
    error = e; // Silence all errors and throw a generic error below
  }
  if (current.length || error) {
    throw new OwlError(`Tokenizer error: could not tokenize \`${expr}\``);
  }
  return result;
}

//------------------------------------------------------------------------------
// Expression "evaluator"
//------------------------------------------------------------------------------

const isLeftSeparator = (token: Token) =>
  token && (token.type === "LEFT_BRACE" || token.type === "COMMA");
const isRightSeparator = (token: Token) =>
  token && (token.type === "RIGHT_BRACE" || token.type === "COMMA");

/**
 * This is the main function exported by this file. This is the code that will
 * process an expression (given as a string) and returns another expression with
 * proper lookups in the context.
 *
 * Usually, this kind of code would be very simple to do if we had an AST (so,
 * if we had a javascript parser), since then, we would only need to find the
 * variables and replace them.  However, a parser is more complicated, and there
 * are no standard builtin parser API.
 *
 * Since this method is applied to simple javasript expressions, and the work to
 * be done is actually quite simple, we actually can get away with not using a
 * parser, which helps with the code size.
 *
 * Here is the heuristic used by this method to determine if a token is a
 * variable:
 * - by default, all symbols are considered a variable
 * - unless the previous token is a dot (in that case, this is a property: `a.b`)
 * - or if the previous token is a left brace or a comma, and the next token is
 *   a colon (in that case, this is an object key: `{a: b}`)
 *
 * Some specific code is also required to support arrow functions. If we detect
 * the arrow operator, then we add the current (or some previous tokens) token to
 * the list of variables so it does not get replaced by a lookup in the context
 */
// Leading spaces are trimmed during tokenization, so they need to be added back for some values
const paddedValues = new Map([
  ["in ", " in "],
  ["instanceof", " instanceof "],
  ["void", "void "],
]);

function render(tokens: Token[]): string {
  let code = "";
  for (const t of tokens) {
    const value = t.isKeyword ? t.value + " " : paddedValues.get(t.value) || t.value;
    // tokens are joined without spaces: `a + +b` must not read as `a++b`, nor
    // `n + ++m` as `n++ + m`
    // nor `return x` as `returnx`
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
  // the parts of an expression that is a whole arrow function
  arrow: { isAsync: boolean; params: string; body: string } | null;
}

const LEFT_GROUPS = new Set<TKind>(["LEFT_BRACE", "LEFT_BRACKET", "LEFT_PAREN"]);
const RIGHT_GROUPS = new Set<TKind>(["RIGHT_BRACE", "RIGHT_BRACKET", "RIGHT_PAREN"]);

/**
 * Turns the parameters of the parenthesized arrow parameter list that ends at
 * `end` into locals, default values and computed keys aside, and returns the
 * index of its "(".
 */
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
  // a default value or a computed key may read an earlier parameter
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

/**
 * Turns the names the declarations of the arrow block body opened at `start`
 * bind into locals, wherever they are in it, and marks their keywords.
 */
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

/**
 * Adds the names bound by the declarators starting at `start` (`a = 1, {b, c:
 * d = 2} = e, [f]`) to `scope`, and returns the index of their last token.
 */
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

/**
 * Adds the names bound by the destructuring pattern (or the parameter list)
 * opened at `start` to `scope`, default values and computed keys aside, and
 * returns the index of its closing token. Its tokens may be compiled already,
 * as a parameter list's are: a name is then the token's `varName`.
 */
function bindPattern(tokens: Token[], start: number, scope: Set<string>): number {
  const levels: { inExpr: boolean; base: boolean; isObject: boolean }[] = [];
  let k = start;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    const level = levels[levels.length - 1];
    if (LEFT_GROUPS.has(t.type)) {
      // a "[" in key position of an object pattern is a computed key
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

/**
 * Whether the `async` at `i` starts an arrow function: `async x =>` or
 * `async (...) =>`. Anywhere else it is a name.
 */
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

/**
 * Processes a javascript expression: compiles variable lookups and detects
 * top-level arrow functions with their free variables, all in a single pass.
 */
export function processExpr(
  expr: string,
  seededLocals?: Set<string>,
  inAsyncArrow: boolean = false
): ProcessedExpr {
  // scope entries carry the stack depth at which they were created
  const scopeStack: { vars: Set<string>; depth: number; ternaries: number; isAsync?: boolean }[] =
    [];

  // Seed outer locals
  // depth: -Infinity so this scope never gets popped
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
  // the open groups: "(", "[", "{", and "BLOCK" for the "{" of an arrow's block body
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
        // Pop arrow scopes whose body has ended (stack dropped below creation depth)
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
          // a statement ends the concise arrows of the block body it is in
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
        // normalize missing tokens: {a} should be equivalent to {a:a}, and the
        // pattern {a = 1} to {a:a = 1}
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
      // a context name may be any string, a keyword included: only where a
      // statement starts, in an arrow's block body, is a keyword one
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
        // Single param without parens (e => ...): token.value is still the
        // raw identifier here, before the isVar block below transforms it.
        // The isVar block will then see isLocal=true and prefix with _.
        newScope.add(token.value);
      }
      const isAsync = !!tokens[paramStart - 1]?.isKeyword;
      if (paramStart === 0 || (paramStart === 1 && isAsync)) {
        topLevelArrowIndex = i + 1;
        topLevelParams = params;
      }
      // record current stack depth so we know when this scope expires
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

/**
 * The `{{ expr }}` and `#{ expr }` interpolations of `s`, each ending at the
 * brace that closes it: an expression may hold braces and strings with "}}".
 * An interpolation that is not closed is text.
 */
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

/**
 * Escapes a string so that it reads as itself inside a template literal.
 */
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
