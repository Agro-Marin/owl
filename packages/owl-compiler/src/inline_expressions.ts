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

const RESERVED_WORDS = new Set(
  "true,false,NaN,null,undefined,debugger,console,window,in,instanceof,new,function,return,eval,void,Math,RegExp,Array,Object,Date,__globals__".split(
    ","
  )
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
  originalValue?: string;
  size?: number;
  varName?: string;
  replace?: Function;
  isLocal?: boolean;
  templateVars?: string[];
  // `async` before an arrow, `await` in an async arrow's body
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

// note that the space after typeof is relevant. It makes sure that the formatted
// expression has a space after typeof. Currently we don't support delete and void
const OPERATORS =
  "...,.,===,==,++,+,!==,!=,!,||,&&,>=,>,<=,<,??=,??,?.,?,--,-,*,/,%,typeof ,=>,=,;,in ,new ,|,&,^,~".split(
    ","
  );

type Tokenizer = (expr: string, previous: Token | undefined) => Token | false;

let tokenizeString: Tokenizer = function (expr) {
  let s = expr[0];
  let start = s;
  if (s !== "'" && s !== '"' && s !== "`") {
    return false;
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
  if (start === "`") {
    return {
      type: "TEMPLATE_STRING",
      value: s,
      replace(replacer: (expr: string) => string) {
        return replaceInterpolations(s, replacer);
      },
    };
  }
  return { type: "VALUE", value: s };
};

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

function findClosingBrace(str: string, start: number): number {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const char = str[i];
    if (char === "'" || char === '"') {
      for (i++; i < str.length && str[i] !== char; i++) {
        if (str[i] === "\\") {
          i++;
        }
      }
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      if (!depth) {
        return i;
      }
      depth--;
    }
  }
  throw new OwlError("Invalid expression");
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

// a / where an operand is expected starts a regular expression literal; after
// a ++ or a --, which a regular expression cannot follow, it is a division
const tokenizeRegExp: Tokenizer = function (expr, previous) {
  if (
    expr[0] !== "/" ||
    (previous &&
      (!OPERAND_PREFIXES.has(previous.type) || previous.value === "++" || previous.value === "--"))
  ) {
    return false;
  }
  let inClass = false;
  let i = 1;
  for (; expr[i] !== "/" || inClass; i++) {
    const char = expr[i];
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
      if (current) {
        const previous = result[result.length - 1];
        const isProperty = previous?.value === "." || previous?.value === "?.";
        for (let tokenizer of isProperty ? PROPERTY_TOKENIZERS : TOKENIZERS) {
          token = tokenizer(current, previous);
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
    const last = code[code.length - 1];
    if ((last === "+" || last === "-") && value[0] === last) {
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
 * `end` into locals, default values aside, and returns the index of its "(".
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
  const levels = [{ inDefault: false, base: false }];
  for (let k = start + 1; k < end; k++) {
    const t = tokens[k];
    const level = levels[levels.length - 1];
    if (LEFT_GROUPS.has(t.type)) {
      levels.push({ inDefault: level.inDefault, base: level.inDefault });
    } else if (RIGHT_GROUPS.has(t.type)) {
      levels.pop();
    } else if (t.type === "COMMA") {
      level.inDefault = level.base;
    } else if (t.type === "OPERATOR" && t.value === "=") {
      level.inDefault = true;
    } else if (t.type === "SYMBOL" && t.varName && !level.inDefault) {
      scope.add(t.varName);
    }
  }
  // a default value may read an earlier parameter
  for (let k = start + 1; k < end; k++) {
    const t = tokens[k];
    if (t.type === "SYMBOL" && t.varName && scope.has(t.varName)) {
      t.value = `_${t.varName}`;
      t.isLocal = true;
    }
  }
  return start;
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
  let stack = []; // to track last opening (, [ or {
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
        if (token.value === "?") {
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
        // normalize missing tokens: {a} should be equivalent to {a:a}
        if (
          groupType === "LEFT_BRACE" &&
          isLeftSeparator(prevToken) &&
          isRightSeparator(nextToken)
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
        token.originalValue = token.value;
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
      : collectVariables(tokens, topLevelArrowIndex + 1).filter((v) => v !== "this");

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

export function compileExpr(expr: string, seededLocals?: Set<string>): string {
  return processExpr(expr, seededLocals).expr;
}

const INTERP_REGEXP = /\{\{.*?\}\}|\#\{.*?\}/g;
const HAS_INTERP_REGEXP = /\{\{.*?\}\}|\#\{.*?\}/;

export function isInterpolated(s: string): boolean {
  return HAS_INTERP_REGEXP.test(s);
}

/**
 * Escapes a string so that it reads as itself inside a template literal.
 */
export function escapeTemplateString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function replaceDynamicParts(s: string, replacer: (s: string) => string) {
  let matches = s.match(INTERP_REGEXP);
  if (matches && matches[0].length === s.length) {
    return `(${replacer(s.slice(2, matches[0][0] === "{" ? -2 : -1))})`;
  }

  let r = "";
  let last = 0;
  for (const match of s.matchAll(INTERP_REGEXP)) {
    const part = match[0];
    r += escapeTemplateString(s.slice(last, match.index));
    r += "${" + replacer(part.slice(2, part[0] === "{" ? -2 : -1)) + "}";
    last = match.index! + part.length;
  }
  return "`" + r + escapeTemplateString(s.slice(last)) + "`";
}
export function interpolate(s: string): string {
  return replaceDynamicParts(s, compileExpr);
}
