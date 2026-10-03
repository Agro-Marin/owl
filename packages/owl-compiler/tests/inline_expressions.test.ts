import { compileExpr, processExpr, tokenize } from "../src/inline_expressions";

describe("tokenizer", () => {
  test("simple tokens", () => {
    expect(tokenize("1.3")).toEqual([{ type: "VALUE", value: "1.3" }]);

    expect(tokenize("{}")).toEqual([
      { type: "LEFT_BRACE", value: "{" },
      { type: "RIGHT_BRACE", value: "}" },
    ]);
    expect(tokenize("{ }}")).toEqual([
      { type: "LEFT_BRACE", value: "{" },
      { type: "RIGHT_BRACE", value: "}" },
      { type: "RIGHT_BRACE", value: "}" },
    ]);
    expect(tokenize("a")).toEqual([{ type: "SYMBOL", value: "a" }]);
    expect(tokenize("true")).toEqual([{ type: "SYMBOL", value: "true" }]);
    expect(tokenize("abcde")).toEqual([{ type: "SYMBOL", value: "abcde" }]);
    expect(tokenize("_ab2")).toEqual([{ type: "SYMBOL", value: "_ab2" }]);
    expect(tokenize("$ab2")).toEqual([{ type: "SYMBOL", value: "$ab2" }]);
    expect(tokenize("ab2$")).toEqual([{ type: "SYMBOL", value: "ab2$" }]);
    expect(tokenize("ABC")).toEqual([{ type: "SYMBOL", value: "ABC" }]);

    expect(tokenize("{a: 2}")).toEqual([
      { type: "LEFT_BRACE", value: "{" },
      { type: "SYMBOL", value: "a" },
      { type: "COLON", value: ":" },
      { type: "VALUE", value: "2" },
      { type: "RIGHT_BRACE", value: "}" },
    ]);
    expect(tokenize("a,")).toEqual([
      { type: "SYMBOL", value: "a" },
      { type: "COMMA", value: "," },
    ]);
    expect(tokenize("][")).toEqual([
      { type: "RIGHT_BRACKET", value: "]" },
      { type: "LEFT_BRACKET", value: "[" },
    ]);
  });

  test("various operators", () => {
    expect(tokenize(">= <= < > !== !=")).toEqual([
      { type: "OPERATOR", value: ">=" },
      { type: "OPERATOR", value: "<=" },
      { type: "OPERATOR", value: "<" },
      { type: "OPERATOR", value: ">" },
      { type: "OPERATOR", value: "!==" },
      { type: "OPERATOR", value: "!=" },
    ]);
    expect(tokenize("typeof a")).toEqual([
      { type: "OPERATOR", value: "typeof " },
      { type: "SYMBOL", value: "a" },
    ]);

    expect(tokenize("a...1")).toEqual([
      { type: "SYMBOL", value: "a" },
      { type: "OPERATOR", value: "..." },
      { type: "VALUE", value: "1" },
    ]);

    expect(tokenize("a in b")).toEqual([
      { type: "SYMBOL", value: "a" },
      { type: "OPERATOR", value: "in " },
      { type: "SYMBOL", value: "b" },
    ]);
  });

  test("strings", () => {
    expect(() => tokenize("'")).toThrow("Tokenizer error: could not tokenize `'`");
    expect(() => tokenize("'\\")).toThrow("Tokenizer error: could not tokenize `'\\`");
    expect(() => tokenize("'\\'")).toThrow("Tokenizer error: could not tokenize `'\\'`");
    expect(tokenize("'hello ged'")).toEqual([{ type: "VALUE", value: "'hello ged'" }]);
    expect(tokenize("'hello \\'ged\\''")).toEqual([{ type: "VALUE", value: "'hello \\'ged\\''" }]);

    expect(() => tokenize('"')).toThrow('Tokenizer error: could not tokenize `"`');
    expect(() => tokenize('"\\"')).toThrow('Tokenizer error: could not tokenize `"\\"`');
    expect(tokenize('"hello ged"')).toEqual([{ type: "VALUE", value: '"hello ged"' }]);
    expect(tokenize('"hello ged"}')).toEqual([
      { type: "VALUE", value: '"hello ged"' },
      { type: "RIGHT_BRACE", value: "}" },
    ]);
    expect(tokenize('"hello \\"ged\\""')).toEqual([{ type: "VALUE", value: '"hello \\"ged\\""' }]);
  });
});

describe("expression evaluation", () => {
  test("simple static values", () => {
    expect(compileExpr("1")).toBe("1");
    expect(compileExpr("1 ")).toBe("1");
    expect(compileExpr("'some string#/, {' ")).toBe("'some string#/, {'");
    expect(compileExpr("{ } ")).toBe("{}");
    expect(compileExpr("{a: 1} ")).toBe("{a:1}");
    expect(compileExpr("{a: 1, b: 2   } ")).toBe("{a:1,b:2}");
    expect(compileExpr("[] ")).toBe("[]");
    expect(compileExpr("[1] ")).toBe("[1]");
    expect(compileExpr("['1', '2'] ")).toBe("['1','2']");
    expect(compileExpr("['1', \"2\"] ")).toBe("['1',\"2\"]");
  });

  test("various types of 'words'", () => {
    expect(compileExpr("true")).toBe("true");
    expect(compileExpr("false")).toBe("false");
    expect(compileExpr("debugger")).toBe("debugger");
  });

  test("a sign or increment after a + or - operator stays its own token", () => {
    const run = (expr: string, ctx: any) => new Function("ctx", `return ${compileExpr(expr)}`)(ctx);
    const ctx = { a: 2, b: 3, n: 1, m: 5 };
    expect(run("a + +b", ctx)).toBe(5);
    expect(run("a - -b", ctx)).toBe(5);
    expect(run("n + ++m", ctx)).toBe(7);
    expect(ctx.n).toBe(1);
    expect(ctx.m).toBe(6);
    expect(run("n - --m", ctx)).toBe(-4);
    expect(compileExpr("x++ + y")).toBe("ctx['x']++ +ctx['y']");
  });

  test("parenthesis", () => {
    expect(compileExpr("(1)")).toBe("(1)");
    expect(compileExpr("a*(1 +3)")).toBe("ctx['a']*(1+3)");
  });

  test("objects and sub objects", () => {
    expect(compileExpr("{a:{b:1}} ")).toBe("{a:{b:1}}");
  });

  test("arrays and objects", () => {
    expect(compileExpr("[{b:1}] ")).toBe("[{b:1}]");
    expect(compileExpr("{a: []} ")).toBe("{a:[]}");
    expect(compileExpr("[{b:1, c: [1, {d: {e: 3}} ]}] ")).toBe("[{b:1,c:[1,{d:{e:3}}]}]");
  });

  test("dot operator", () => {
    expect(compileExpr("a.b")).toBe("ctx['a'].b");
    expect(compileExpr("a.b.c")).toBe("ctx['a'].b.c");
  });

  test("various unary operators", () => {
    expect(compileExpr("!flag")).toBe("!ctx['flag']");
    expect(compileExpr("-3")).toBe("-3");
    expect(compileExpr("-a")).toBe("-ctx['a']");
    expect(compileExpr("typeof a")).toBe("typeof ctx['a']");
  });

  test("various binary operators", () => {
    expect(compileExpr("color == 'black'")).toBe("ctx['color']=='black'");
    expect(compileExpr("a || b")).toBe("ctx['a']||ctx['b']");
    expect(compileExpr("color === 'black'")).toBe("ctx['color']==='black'");
    expect(compileExpr("'li_'+item")).toBe("'li_'+ctx['item']");
    expect(compileExpr("state.val > 1")).toBe("ctx['state'].val>1");
    expect(compileExpr("a in b")).toBe("ctx['a'] in ctx['b']");
  });

  test("boolean operations", () => {
    expect(compileExpr("a && b")).toBe("ctx['a']&&ctx['b']");
  });

  test("ternary operators", () => {
    expect(compileExpr("a ? b: '2'")).toBe("ctx['a']?ctx['b']:'2'");
    expect(compileExpr("a ? b: (c or '2') ")).toBe("ctx['a']?ctx['b']:(ctx['c']||'2')");
    expect(compileExpr("a ? {test:c}: [1,u]")).toBe("ctx['a']?{test:ctx['c']}:[1,ctx['u']]");
  });

  test("word replacement", () => {
    expect(compileExpr("a or b")).toBe("ctx['a']||ctx['b']");
    expect(compileExpr("a and b")).toBe("ctx['a']&&ctx['b']");
  });

  test("keyword operators keep their spacing", () => {
    expect(compileExpr("x instanceof Array")).toBe("ctx['x'] instanceof Array");
    expect(compileExpr("void 0")).toBe("void 0");
    expect(compileExpr("typeof(x)")).toBe("typeof (ctx['x'])");
    expect(compileExpr("a in(b)")).toBe("ctx['a'] in (ctx['b'])");
    expect(compileExpr("index + newValue + typeofX")).toBe(
      "ctx['index']+ctx['newValue']+ctx['typeofX']"
    );
  });

  test("word replacement does not apply to properties", () => {
    expect(compileExpr("o.lt")).toBe("ctx['o'].lt");
    expect(compileExpr("o.and(o.or)")).toBe("ctx['o'].and(ctx['o'].or)");
    expect(compileExpr("a.gte and b")).toBe("ctx['a'].gte&&ctx['b']");
    expect(compileExpr("o.in + o.typeof + o.new")).toBe("ctx['o'].in+ctx['o'].typeof+ctx['o'].new");
  });

  test("numeric literals", () => {
    expect(compileExpr("1e3")).toBe("1e3");
    expect(compileExpr("1.5e-3 + 2E+2")).toBe("1.5e-3+2E+2");
    expect(compileExpr("0x1F + 0b10 + 0o17")).toBe("0x1F+0b10+0o17");
    expect(compileExpr("1_000 + 10n")).toBe("1_000+10n");
  });

  test("unicode identifiers", () => {
    expect(compileExpr("año + 1")).toBe("ctx['año']+1");
    expect(compileExpr("état.ça")).toBe("ctx['état'].ça");
  });

  test("function calls", () => {
    expect(compileExpr("a()")).toBe("ctx['a']()");
    expect(compileExpr("a(1)")).toBe("ctx['a'](1)");
    expect(compileExpr("a(1,2)")).toBe("ctx['a'](1,2)");
    expect(compileExpr("a(1,2,{a:[a]})")).toBe("ctx['a'](1,2,{a:[ctx['a']]})");
    expect(compileExpr("'x'.toUpperCase()")).toBe("'x'.toUpperCase()");
    expect(compileExpr("'x'.toUpperCase({a: 3})")).toBe("'x'.toUpperCase({a:3})");
  });

  test("arrow functions", () => {
    expect(compileExpr("list.map(e => e.val)")).toBe("ctx['list'].map(_e=>_e.val)");
    expect(compileExpr("list.map(e => a + e)")).toBe("ctx['list'].map(_e=>ctx['a']+_e)");
    expect(compileExpr("list.map((e) => e)")).toBe("ctx['list'].map((_e)=>_e)");
    expect(compileExpr("list.map((elem, index) => elem + index)")).toBe(
      "ctx['list'].map((_elem,_index)=>_elem+_index)"
    );
    expect(compileExpr("(ev => ev)(e)")).toBe("(_ev=>_ev)(ctx['e'])");
    expect(compileExpr("(v1) => myFunc(v1)")).toBe("(_v1)=>ctx['myFunc'](_v1)");
    expect(compileExpr("list.data.map((data) => data)")).toBe(
      "ctx['list'].data.map((_data)=>_data)"
    );
    expect(compileExpr("(ev) => { myFunc(v1, v2, ev.target.value); }")).toBe(
      "(_ev)=>{ctx['myFunc'](ctx['v1'],ctx['v2'],_ev.target.value);}"
    );
    expect(compileExpr("list.map((e) => ({a: e,b:(e),c:d,d:e}))")).toBe(
      "ctx['list'].map((_e)=>({a:_e,b:(_e),c:ctx['d'],d:_e}))"
    );
  });
  test("processExpr: free variables detection", () => {
    const freeVars = (expr: string) => processExpr(expr).freeVariables;
    // simple arrow
    expect(freeVars("x => this.doSomething(x, item)")).toEqual(["item"]);
    // parenthesized single param
    expect(freeVars("(a) => this.doSomething(a, item)")).toEqual(["item"]);
    // parenthesized multi params
    expect(freeVars("(a, b) => this.doSomething(a, b, item)")).toEqual(["item"]);
    // no free vars
    expect(freeVars("(a) => a")).toEqual([]);
    // not an arrow function
    expect(freeVars("this.doSomething(item)")).toBeNull();
  });

  test("processExpr: only a whole-expression arrow has free variables", () => {
    const freeVars = (expr: string) => processExpr(expr).freeVariables;
    expect(freeVars("this.state.flag ? () => 'A' : () => 'B'")).toBeNull();
    expect(freeVars("n > 1 ? () => 'big' : () => 'small'")).toBeNull();
    expect(freeVars("f(() => a)")).toBeNull();
    expect(freeVars("x => y => x + y + z")).toEqual(["z"]);
  });

  test("processExpr: free variables inside template string interpolations", () => {
    const freeVars = (expr: string) => processExpr(expr).freeVariables;
    expect(freeVars("() => `hi ${name}`")).toEqual(["name"]);
    expect(freeVars("(a) => `${a} and ${b}` + c")).toEqual(["b", "c"]);
  });

  test("arrow function parameters go out of scope where the body ends", () => {
    expect(compileExpr("f({a: (v) => v, b: v})")).toBe("ctx['f']({a:(_v)=>_v,b:ctx['v']})");
    expect(compileExpr("f(e => e, e)")).toBe("ctx['f'](_e=>_e,ctx['e'])");
    expect(compileExpr("c ? x => x : x")).toBe("ctx['c']?_x=>_x:ctx['x']");
    expect(compileExpr("c ? x => y => x + y : x + y")).toBe(
      "ctx['c']?_x=>_y=>_x+_y:ctx['x']+ctx['y']"
    );
    expect(compileExpr("f(x => x ? x : 0, x)")).toBe("ctx['f'](_x=>_x?_x:0,ctx['x'])");
    expect(compileExpr("f(x => ({a: x, b: x}), x)")).toBe("ctx['f'](_x=>({a:_x,b:_x}),ctx['x'])");
  });

  test("optional chaining and nullish coalescing are not ternaries", () => {
    expect(compileExpr("c ? y => y?.length : y")).toBe("ctx['c']?_y=>_y?.length:ctx['y']");
    expect(compileExpr("c ? y => y ?? 1 : y")).toBe("ctx['c']?_y=>_y??1:ctx['y']");
    expect(compileExpr("a?.b?.[c]?.(d)")).toBe("ctx['a']?.b?.[ctx['c']]?.(ctx['d'])");
    expect(compileExpr("a?.in")).toBe("ctx['a']?.in");
    expect(compileExpr("a ??= b")).toBe("ctx['a']??=ctx['b']");
    expect(compileExpr("a?.5:1")).toBe("ctx['a']?.5:1");
  });

  test("regular expression literals", () => {
    expect(compileExpr("/ab/.test(s)")).toBe("/ab/.test(ctx['s'])");
    expect(compileExpr("s.replace(/[/x]\\s+/gi, '')")).toBe("ctx['s'].replace(/[/x]\\s+/gi,'')");
    expect(compileExpr("a / b / c")).toBe("ctx['a']/ctx['b']/ctx['c']");
    expect(compileExpr("(a) / 2")).toBe("(ctx['a'])/2");
  });

  test("a / after an operand is a division, a postfix ++ or -- included", () => {
    expect(compileExpr("n++ / 2")).toBe("ctx['n']++/2");
    expect(compileExpr("n--/2/m")).toBe("ctx['n']--/2/ctx['m']");
    expect(compileExpr("a[0] / b")).toBe("ctx['a'][0]/ctx['b']");
    expect(compileExpr("1 / b")).toBe("1/ctx['b']");
    expect(compileExpr("`a/${b}` / 2")).toBe("`a/${ctx['b']}`/2");
    expect(compileExpr("a.b / 2")).toBe("ctx['a'].b/2");
    expect(compileExpr("x ? /a/ : /b/")).toBe("ctx['x']?/a/:/b/");
  });

  test("word operators as object keys", () => {
    expect(compileExpr("({gt: 1, lt: a}).gt")).toBe("({gt:1,lt:ctx['a']}).gt");
    expect(compileExpr("{and, or}")).toBe("{and:ctx['and'],or:ctx['or']}");
    expect(compileExpr("a gt b")).toBe("ctx['a']>ctx['b']");
  });

  test("async arrow functions", () => {
    expect(compileExpr("async () => { await this.f(); }")).toBe(
      "async ()=>{await ctx['this'].f();}"
    );
    expect(compileExpr("async x => await f(x)")).toBe("async _x=>await ctx['f'](_x)");
    expect(processExpr("async (a) => f(a, b)").freeVariables).toEqual(["f", "b"]);
  });

  test("async and await are variables outside an async arrow", () => {
    expect(compileExpr("await.x")).toBe("ctx['await'].x");
    expect(compileExpr("async")).toBe("ctx['async']");
    expect(compileExpr("async(1)")).toBe("ctx['async'](1)");
    expect(compileExpr("{async, await}")).toBe("{async:ctx['async'],await:ctx['await']}");
    expect(compileExpr("a.async + b.await")).toBe("ctx['a'].async+ctx['b'].await");
    expect(compileExpr("() => await")).toBe("()=>ctx['await']");
    expect(compileExpr("async () => () => await")).toBe("async ()=>()=>ctx['await']");
    expect(compileExpr("async (a) => await a")).toBe("async (_a)=>await _a");
    expect(compileExpr("async () => `${await f()}`")).toBe("async ()=>`${await ctx['f']()}`");
    expect(compileExpr("() => `${await}`")).toBe("()=>`${ctx['await']}`");
  });

  test("arrow parameters with default values", () => {
    expect(compileExpr("(a = f()) => a")).toBe("(_a=ctx['f']())=>_a");
    expect(compileExpr("(a, b = g(a, c)) => a + b + c")).toBe(
      "(_a,_b=ctx['g'](_a,ctx['c']))=>_a+_b+ctx['c']"
    );
    expect(compileExpr("({x, y: [z]} = d) => x + z")).toBe("({x:_x,y:[_z]}=ctx['d'])=>_x+_z");
  });

  test("arrow functions: not yet supported", () => {
    expect(compileExpr("(e => e)(e)")).toBe("(_e=>_e)(ctx['e'])");
  });

  test("assignation", () => {
    expect(compileExpr("a = b")).toBe("ctx['a']=ctx['b']");
    expect(compileExpr("a += b")).toBe("ctx['a']+=ctx['b']");
    expect(compileExpr("a -= b")).toBe("ctx['a']-=ctx['b']");
    expect(compileExpr("a.b = !a.b")).toBe("ctx['a'].b=!ctx['a'].b");
  });

  test("spread operator", () => {
    expect(compileExpr("[...state.list]")).toBe("[...ctx['state'].list]");
    expect(compileExpr("f(...state.list)")).toBe("ctx['f'](...ctx['state'].list)");
    expect(compileExpr("f([...list])")).toBe("ctx['f']([...ctx['list']])");
  });

  test("works with builtin properties", () => {
    expect(compileExpr("state.constructor.name")).toBe("ctx['state'].constructor.name");
  });

  test("works with shortcut object key description", () => {
    expect(compileExpr("{a}")).toBe("{a:ctx['a']}");
    expect(compileExpr("{a,b}")).toBe("{a:ctx['a'],b:ctx['b']}");
    expect(compileExpr("{a,b:3,c}")).toBe("{a:ctx['a'],b:3,c:ctx['c']}");
  });

  test("template string interpolations with braces", () => {
    expect(compileExpr("`${f({x})}`")).toBe("`${ctx['f']({x:ctx['x']})}`");
    expect(compileExpr("`${ {a: b}.a } and ${'}'}`")).toBe("`${{a:ctx['b']}.a} and ${'}'}`");
    expect(compileExpr("`\\${a}`")).toBe("`\\${a}`");
  });

  test("template strings", () => {
    expect(compileExpr("`hey`")).toBe("`hey`");
    expect(compileExpr("`hey ${you}`")).toBe("`hey ${ctx['you']}`");
    expect(compileExpr("`hey ${1 + 2}`")).toBe("`hey ${1+2}`");
    (expect(compileExpr("`${e.target.name}`")).toBe("`${ctx['e'].target.name}`"),
      expect(compileExpr("(e) => `${e.target.name}`")).toBe("(_e)=>`${_e.target.name}`"));
    expect(compileExpr("items.map(x => `${x.label}: ${title}`)")).toBe(
      "ctx['items'].map(_x=>`${_x.label}: ${ctx['title']}`)"
    );
  });

  test("works with short object description and lists ", () => {
    expect(compileExpr("[a, b]")).toBe("[ctx['a'],ctx['b']]");
    expect(compileExpr("[a, b, c]")).toBe("[ctx['a'],ctx['b'],ctx['c']]");
    expect(compileExpr("[a, {b, c},d]")).toBe("[ctx['a'],{b:ctx['b'],c:ctx['c']},ctx['d']]");
    expect(compileExpr("{a:[b, {c, d: e}]}")).toBe("{a:[ctx['b'],{c:ctx['c'],d:ctx['e']}]}");
  });

  test("preserving spaces where needed for text operators", () => {
    expect(compileExpr("new Date()")).toBe("new Date()");
    expect(compileExpr("a.c in b")).toBe("ctx['a'].c in ctx['b']");
    expect(compileExpr("typeof val")).toBe("typeof ctx['val']");
  });

  test("binary operators", () => {
    expect(compileExpr("1 | 1")).toBe("1|1");
    expect(compileExpr("1 & 1")).toBe("1&1");
    expect(compileExpr("1 ^ 1")).toBe("1^1");
    expect(compileExpr("~1")).toBe("~1");
  });
});
