import { compileExpr } from "../src/inline_expressions";

// Random expressions, each written twice: in template syntax (word operators
// allowed) and as the plain JavaScript it means. The compiled template form,
// evaluated against a context, must give what JavaScript gives for the plain
// form with the same variables in scope.

function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const SCOPE = {
  a: 3,
  b: -2,
  s: "hey",
  o: { x: 1, y: { z: 2 }, list: [4, 5], and: 7, gt: 8, new: 9, f: () => 6, k: "x" },
  arr: [1, 2, 3],
  n: null,
  u: undefined,
  t: true,
};
const NAMES = Object.keys(SCOPE);

type Pair = [template: string, plain: string];

function generator(random: () => number) {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const same = (code: string): Pair => [code, code];
  function atom(locals: string[]): Pair {
    const r = random();
    if (r < 0.3) {
      return same(pick([...NAMES, ...locals]));
    }
    if (r < 0.5) {
      return same(pick(["0", "1", "2.5", "10", "'x'", '"y"', "''", "null", "true", "false"]));
    }
    if (r < 0.65) {
      return same(
        pick([
          "o.x",
          "o.y.z",
          "o?.y?.z",
          "n?.x",
          "u?.x",
          "o['x']",
          "o.list[1]",
          "arr.length",
          "s.length",
        ])
      );
    }
    return same(pick(["arr[0]", "arr[2]", "o.y", "o.list"]));
  }
  function expr(locals: string[], depth: number): Pair {
    if (depth > 3) {
      return atom(locals);
    }
    const sub = () => expr(locals, depth + 1);
    const r = random();
    if (r < 0.22) {
      const [l, lp] = sub();
      const [rt, rp] = sub();
      const op = pick(["+", "-", "*", "%", "===", "!==", "<", ">", "<=", ">=", "&&", "||", "??"]);
      return [`(${l}) ${op} (${rt})`, `(${lp}) ${op} (${rp})`];
    }
    if (r < 0.3) {
      const [l, lp] = sub();
      const [rt, rp] = sub();
      const [word, op] = pick([
        ["and", "&&"],
        ["or", "||"],
        ["gt", ">"],
        ["gte", ">="],
        ["lt", "<"],
        ["lte", "<="],
      ]);
      return [`(${l}) ${word} (${rt})`, `(${lp}) ${op} (${rp})`];
    }
    if (r < 0.38) {
      const [e, ep] = sub();
      const op = pick(["!", "-", "typeof "]);
      return [`${op}(${e})`, `${op}(${ep})`];
    }
    if (r < 0.46) {
      const [c, cp] = sub();
      const [y, yp] = sub();
      const [z, zp] = sub();
      return [`(${c}) ? (${y}) : (${z})`, `(${cp}) ? (${yp}) : (${zp})`];
    }
    if (r < 0.58) {
      const local = pick(["x", "item", "k"]);
      const inner = expr([...locals, local], depth + 1);
      const shape = pick(["map", "filter", "some", "find"]);
      const tail = shape === "map" || shape === "filter" ? ".join(',')" : "";
      if (random() < 0.3) {
        return [
          `arr.${shape}((${local}) => { const w = ${local} * 2; return (${inner[0]}) || w; })${tail}`,
          `arr.${shape}((${local}) => { const w = ${local} * 2; return (${inner[1]}) || w; })${tail}`,
        ];
      }
      return [
        `arr.${shape}((${local}) => (${inner[0]}))${tail}`,
        `arr.${shape}((${local}) => (${inner[1]}))${tail}`,
      ];
    }
    if (r < 0.66) {
      const [e, ep] = sub();
      return [`\`<\${${e}}>\${s}\``, `\`<\${${ep}}>\${s}\``];
    }
    if (r < 0.74) {
      const [e, ep] = sub();
      const [f, fp] = sub();
      return pick<Pair>([
        [`{ k: ${e}, x: ${f} }.k`, `({ k: ${ep}, x: ${fp} }).k`],
        [`[${e}, ${f}].length`, `[${ep}, ${fp}].length`],
        [`[...arr, ${e}].length`, `[...arr, ${ep}].length`],
        [`{ ...o, x: ${e} }.x`, `({ ...o, x: ${ep} }).x`],
        [`Math.max(1, ${e})`, `Math.max(1, ${ep})`],
      ]);
    }
    if (r < 0.8) {
      const [e, ep] = sub();
      return pick<Pair>([
        [`String(${e}) in o`, `String(${ep}) in o`],
        [`/e/.test(String(${e}))`, `/e/.test(String(${ep}))`],
        [`s.slice(0, 2) + (${e})`, `s.slice(0, 2) + (${ep})`],
      ]);
    }
    if (r < 0.92) {
      const [e, ep] = sub();
      const [f, fp] = sub();
      return pick<Pair>([
        [`{ a, s }.a + (${e})`, `({ a, s }).a + (${ep})`],
        [`{ [s]: ${e} }[s]`, `({ [s]: ${ep} })[s]`],
        [`(() => ({ v: ${e} }))().v`, `(() => ({ v: ${ep} }))().v`],
        [`((p = ${e}) => p)()`, `((p = ${ep}) => p)()`],
        [`(({ x }) => x + (${e}))(o)`, `(({ x }) => x + (${ep}))(o)`],
        [`o.list?.[${e}]`, `o.list?.[${ep}]`],
        [`n?.[${e}]`, `n?.[${ep}]`],
        [`o.f?.() + (${e})`, `o.f?.() + (${ep})`],
        [`u?.f?.(${e})`, `u?.f?.(${ep})`],
        [`(${e}) / 2 / (a || 1)`, `(${ep}) / 2 / (a || 1)`],
        [`'it"s' + "a'b" + '\${x}' + (${e})`, `'it"s' + "a'b" + '\${x}' + (${ep})`],
        [`o.and + o.gt + o.new + (${e})`, `o.and + o.gt + o.new + (${ep})`],
        [`{ gt: ${e}, and: ${f} }.gt`, `({ gt: ${ep}, and: ${fp} }).gt`],
        [`(${e}) ** 2`, `(${ep}) ** 2`],
        [`((${e}) & 3) | ((${f}) ^ 1)`, `((${ep}) & 3) | ((${fp}) ^ 1)`],
        [`~(${e}) + +(${f})`, `~(${ep}) + +(${fp})`],
        [`void (${e})`, `void (${ep})`],
        [`typeof (${e}) === 'undefined'`, `typeof (${ep}) === 'undefined'`],
        [`new Date(0).getTime() + (${e})`, `new Date(0).getTime() + (${ep})`],
        [`\`a\${\`b\${${e}}\`}\``, `\`a\${\`b\${${ep}}\`}\``],
        [`/[/]/.test(String(${e}))`, `/[/]/.test(String(${ep}))`],
        [`!!(${e}) && !(${f})`, `!!(${ep}) && !(${fp})`],
        [`(${e}) ?? (${f}) ?? 0`, `(${ep}) ?? (${fp}) ?? 0`],
        [`o[o.k] + (${e})`, `o[o.k] + (${ep})`],
      ]);
    }
    return atom(locals);
  }
  return () => expr([], 0);
}

function evaluate(fn: () => unknown): string {
  try {
    const value = fn();
    if (typeof value === "function") {
      return "function";
    }
    if (typeof value === "number" && Number.isNaN(value)) {
      return "NaN";
    }
    return `${typeof value}:${JSON.stringify(value)}`;
  } catch (error: any) {
    return `throws ${error?.constructor?.name}`;
  }
}

function check(template: string, plain: string): string | null {
  let compiled: string;
  try {
    compiled = compileExpr(template);
  } catch (error: any) {
    return `${template}\n  compile error: ${error.message}`;
  }
  const native = evaluate(() =>
    new Function(...NAMES, `return (${plain});`)(...NAMES.map((n) => (SCOPE as any)[n]))
  );
  const owl = evaluate(() => new Function("ctx", `return (${compiled});`)({ ...SCOPE }));
  return native === owl ? null : `${template}\n  compiled ${compiled}\n  js ${native}, owl ${owl}`;
}

const COUNT = Number(process.env.OWL_EXPR_FUZZ || 3000);

test("compiled template expressions evaluate as the JavaScript they mean", () => {
  const next = generator(prng(11));
  const failures: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const [template, plain] = next();
    const failure = check(template, plain);
    if (failure) {
      failures.push(failure);
    }
  }
  expect(failures.slice(0, 5)).toEqual([]);
});
