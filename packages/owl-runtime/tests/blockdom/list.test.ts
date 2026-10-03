import { list, mount, multi, patch, text, createBlock, VNode } from "../../src/blockdom";
import { makeTestFixture } from "./helpers";

//------------------------------------------------------------------------------
// Setup and helpers
//------------------------------------------------------------------------------

function withKey(vnode: VNode, key: any) {
  vnode.key = key;
  return vnode;
}

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

afterEach(() => {
  fixture.remove();
});

function kText(str: string, key: any): VNode {
  return withKey(text(str), key);
}

function n(n: number) {
  return kText(String(n), n);
}

const span = createBlock("<span><block-text-0/></span>");
const p = createBlock("<p><block-text-0/></p>");

function kSpan(str: string, key: any): VNode {
  return withKey(span([str]), key);
}

function kPair(n: number): VNode {
  const bnodes = [p([String(n)]), p([String(n)])];
  return withKey(multi(bnodes), n);
}

describe("list node: misc", () => {
  test("list node", async () => {
    const bnodes = [1, 2, 3].map((key) => kText(`text${key}`, key));

    const tree = list(bnodes);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("text1text2text3");
  });

  test("list vnode can be used as text", () => {
    mount(text(list([text("a"), text("b")]) as any), fixture);
    expect(fixture.innerHTML).toBe("ab");
  });

  test("a list block can be removed and leaves nothing", async () => {
    const bnodes = [
      { id: 1, name: "sheep" },
      { id: 2, name: "cow" },
    ].map((elem) => kText(elem.name, elem.id));

    const tree = list(bnodes);
    expect(fixture.childNodes.length).toBe(0);
    mount(tree, fixture);
    expect(fixture.childNodes.length).toBe(3);
    expect(fixture.innerHTML).toBe("sheepcow");

    tree.remove();
    expect(fixture.innerHTML).toBe("");
    expect(fixture.childNodes.length).toBe(0);
  });

  test("patching a list block inside an elem block", async () => {
    const block = createBlock("<div><block-child-0/></div>");
    const tree = block();
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<div></div>");

    patch(tree, block([], [list([1, 2, 3].map(n))]));
    expect(fixture.innerHTML).toBe("<div>123</div>");

    patch(tree, block([], [list([])]));
    expect(fixture.innerHTML).toBe("<div></div>");

    patch(tree, block([], [list([1, 2, 3].map(n))]));
    expect(fixture.innerHTML).toBe("<div>123</div>");
  });

  test("list of lists", async () => {
    const tree = list([
      withKey(list([kText("a1", "1"), kText("a2", "2")]), "a"),
      withKey(list([kText("b1", "1"), kText("b2", "2")]), "b"),
    ]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("a1a2b1b2");

    patch(
      tree,
      list([
        withKey(list([kText("b1", "1"), kText("b2", "2")]), "b"),
        withKey(list([kText("a1", "1"), kText("a2", "2")]), "a"),
      ])
    );

    expect(fixture.innerHTML).toBe("b1b2a1a2");

    patch(
      tree,
      list([
        withKey(list([kText("a2", "2"), kText("a1", "1")]), "a"),
        withKey(list([kText("b2", "2"), kText("b1", "1")]), "b"),
      ])
    );

    expect(fixture.innerHTML).toBe("a2a1b2b1");
  });
});

describe("adding/removing elements", () => {
  test("removing elements", () => {
    const tree = list([kText("a", "a")]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("a");

    patch(tree, list([]));
    expect(fixture.innerHTML).toBe("");
  });

  test("removing 1 elements from 2", () => {
    const tree = list([kText("a", "a"), kText("b", "b")]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("ab");

    patch(tree, list([kText("a", "a")]));
    expect(fixture.innerHTML).toBe("a");
  });

  test("removing elements", () => {
    const tree = list([kSpan("a", "a")]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<span>a</span>");

    patch(tree, list([]));
    expect(fixture.innerHTML).toBe("");
  });

  test("removing elements, variation", () => {
    const f = (i: number) => {
      const b = multi([span([`a${i}`]), span([`b${i}`])]);
      b.key = i;
      return b;
    };
    const tree = list([f(1), f(2)]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<span>a1</span><span>b1</span><span>a2</span><span>b2</span>");

    patch(tree, list([]));
    expect(fixture.innerHTML).toBe("");
  });

  test("adding one element at the end", () => {
    const tree = list([n(1), n(2)]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("12");

    patch(tree, list([n(1), n(2), n(3)]));
    expect(fixture.innerHTML).toBe("123");
  });

  test("adding one element at the end", () => {
    const tree = list([n(1)]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("1");

    patch(tree, list([n(1), n(2), n(3)]));
    expect(fixture.innerHTML).toBe("123");
  });

  test("prepend elements: 4,5 => 1,2,3,4,5", () => {
    const tree = list([n(4), n(5)]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("45");

    patch(tree, list([n(1), n(2), n(3), n(4), n(5)]));
    expect(fixture.innerHTML).toBe("12345");
  });

  test("prepend elements: 4,5 => 1,2,3,4,5 (with multi)", () => {
    const tree = list([kPair(4), kPair(5)]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<p>4</p><p>4</p><p>5</p><p>5</p>");

    patch(tree, list([1, 2, 3, 4, 5].map(kPair)));
    expect(fixture.innerHTML).toBe(
      "<p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p><p>4</p><p>4</p><p>5</p><p>5</p>"
    );
  });

  test("add element in middle: 1,2,4,5 => 1,2,3,4,5", () => {
    const tree = list([1, 2, 4, 5].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("1245");

    patch(tree, list([1, 2, 3, 4, 5].map(n)));
    expect(fixture.innerHTML).toBe("12345");
  });

  test("add element in middle: 1,2,4,5 => 1,2,3,4,5 (multi)", () => {
    const tree = list([1, 2, 4, 5].map(kPair));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe(
      "<p>1</p><p>1</p><p>2</p><p>2</p><p>4</p><p>4</p><p>5</p><p>5</p>"
    );

    patch(tree, list([1, 2, 3, 4, 5].map(kPair)));
    expect(fixture.innerHTML).toBe(
      "<p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p><p>4</p><p>4</p><p>5</p><p>5</p>"
    );
  });

  test("add element at beginning and end: 2,3,4 => 1,2,3,4,5", () => {
    const tree = list([2, 3, 4].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("234");

    patch(tree, list([1, 2, 3, 4, 5].map(n)));
    expect(fixture.innerHTML).toBe("12345");
  });

  test("add element at beginning and end: 2,3,4 => 1,2,3,4,5 (multi)", () => {
    const tree = list([2, 3, 4].map(kPair));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<p>2</p><p>2</p><p>3</p><p>3</p><p>4</p><p>4</p>");

    patch(tree, list([1, 2, 3, 4, 5].map(kPair)));
    expect(fixture.innerHTML).toBe(
      "<p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p><p>4</p><p>4</p><p>5</p><p>5</p>"
    );
  });

  test("adds children: [] => [1,2,3]", () => {
    const tree = list([].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("");

    patch(tree, list([1, 2, 3].map(n)));
    expect(fixture.innerHTML).toBe("123");
  });

  test("adds children: [] => [1,2,3] (multi)", () => {
    const tree = list([].map(kPair));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("");

    patch(tree, list([1, 2, 3].map(kPair)));
    expect(fixture.innerHTML).toBe("<p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p>");
  });

  test("adds children: [] => [1,2,3] (inside elem)", () => {
    const block = createBlock("<p><block-child-0/></p>");
    const tree = block([], []);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<p></p>");

    patch(tree, block([], [list([1, 2, 3].map(n))]));
    expect(fixture.innerHTML).toBe("<p>123</p>");
  });

  test("adds children: [] => [1,2,3] (inside elem, multi)", () => {
    const block = createBlock("<p><block-child-0/></p>");
    const tree = block([], []);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<p></p>");

    patch(tree, block([], [list([1, 2, 3].map(kPair))]));
    expect(fixture.innerHTML).toBe("<p><p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p></p>");
  });

  test("remove children: [1,2,3] => []", () => {
    const tree = list([1, 2, 3].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("123");

    patch(tree, list([].map(n)));
    expect(fixture.innerHTML).toBe("");
  });

  test("remove children: [1,2,3] => [] (multi)", () => {
    const tree = list([1, 2, 3].map(kPair));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p>");

    patch(tree, list([].map(kPair)));
    expect(fixture.innerHTML).toBe("");
  });

  test("remove children: [1,2,3] => [] (inside elem)", () => {
    const block = createBlock("<p><block-child-0/></p>");
    const tree = block([], [list([1, 2, 3].map(n))]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<p>123</p>");

    patch(tree, block([], [list([])]));
    expect(fixture.innerHTML).toBe("<p></p>");
  });

  test("remove children from the beginning: [1,2,3,4,5] => [3,4,5]", () => {
    const tree = list([1, 2, 3, 4, 5].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("12345");

    patch(tree, list([3, 4, 5].map(n)));
    expect(fixture.innerHTML).toBe("345");
  });

  test("remove children from the beginning: [1,2,3,4,5] => [3,4,5] (multi)", () => {
    const tree = list([1, 2, 3, 4, 5].map(kPair));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe(
      "<p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p><p>4</p><p>4</p><p>5</p><p>5</p>"
    );
    patch(tree, list([3, 4, 5].map(kPair)));
    expect(fixture.innerHTML).toBe("<p>3</p><p>3</p><p>4</p><p>4</p><p>5</p><p>5</p>");
  });

  test("remove children from the end: [1,2,3,4,5] => [1,2,3]", () => {
    const tree = list([1, 2, 3, 4, 5].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("12345");

    patch(tree, list([1, 2, 3].map(n)));
    expect(fixture.innerHTML).toBe("123");
  });

  test("remove children from the middle: [1,2,3,4,5] => [1,2,4,5]", () => {
    const tree = list([1, 2, 3, 4, 5].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("12345");

    patch(tree, list([1, 2, 4, 5].map(n)));
    expect(fixture.innerHTML).toBe("1245");
  });
});

describe("element reordering", () => {
  test("move element forward: [1,2,3,4] => [2,3,1,4]", () => {
    const tree = list([1, 2, 3, 4].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("1234");

    patch(tree, list([2, 3, 1, 4].map(n)));
    expect(fixture.innerHTML).toBe("2314");
  });

  test("move element forward: [1,2,3,4] => [2,3,1,4] (multi)", () => {
    const tree = list([1, 2, 3, 4].map(kPair));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe(
      "<p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p><p>4</p><p>4</p>"
    );
    patch(tree, list([2, 3, 1, 4].map(kPair)));
    expect(fixture.innerHTML).toBe(
      "<p>2</p><p>2</p><p>3</p><p>3</p><p>1</p><p>1</p><p>4</p><p>4</p>"
    );
  });

  test("move element to end: [1,2,3] => [2,3,1]", () => {
    const tree = list([1, 2, 3].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("123");

    patch(tree, list([2, 3, 1].map(n)));
    expect(fixture.innerHTML).toBe("231");
  });

  test("move element to end: [1,2,3] => [2,3,1] (multi)", () => {
    const tree = list([1, 2, 3].map(kPair));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("<p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p>");

    patch(tree, list([2, 3, 1].map(kPair)));
    expect(fixture.innerHTML).toBe("<p>2</p><p>2</p><p>3</p><p>3</p><p>1</p><p>1</p>");
  });

  test("move element backward: [1,2,3,4] => [1,4,2,3]", () => {
    const tree = list([1, 2, 3, 4].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("1234");

    patch(tree, list([1, 4, 2, 3].map(n)));
    expect(fixture.innerHTML).toBe("1423");
  });

  test("swaps first and last: [1,2,3,4] => [4,3,2,1]", () => {
    const tree = list([1, 2, 3, 4].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("1234");

    patch(tree, list([4, 3, 2, 1].map(n)));
    expect(fixture.innerHTML).toBe("4321");
  });
});

describe("miscellaneous operations", () => {
  test("move to left and replace: [1,2,3,4,5] => [4,1,2,3,6]", () => {
    const tree = list([1, 2, 3, 4, 5].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("12345");

    patch(tree, list([4, 1, 2, 3, 6].map(n)));
    expect(fixture.innerHTML).toBe("41236");
  });

  test("move to left and replace: [1,2,3,4,5] => [4,1,2,3,6] (multi)", () => {
    const tree = list([1, 2, 3, 4, 5].map(kPair));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe(
      "<p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p><p>4</p><p>4</p><p>5</p><p>5</p>"
    );

    patch(tree, list([4, 1, 2, 3, 6].map(kPair)));
    expect(fixture.innerHTML).toBe(
      "<p>4</p><p>4</p><p>1</p><p>1</p><p>2</p><p>2</p><p>3</p><p>3</p><p>6</p><p>6</p>"
    );
  });

  test("move to left and leave hole: [1,4,5] => [4,6]", () => {
    const tree = list([1, 4, 5].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("145");

    patch(tree, list([4, 6].map(n)));
    expect(fixture.innerHTML).toBe("46");
  });

  test("[2,4,5] => [4,5,3]", () => {
    const tree = list([2, 4, 5].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("245");

    patch(tree, list([4, 5, 3].map(n)));
    expect(fixture.innerHTML).toBe("453");
  });

  test("reverse elements [1,2,3,4,5,6,7,8] => [8,7,6,5,4,3,2,1]", () => {
    const tree = list([1, 2, 3, 4, 5, 6, 7, 8].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("12345678");

    patch(tree, list([8, 7, 6, 5, 4, 3, 2, 1].map(n)));
    expect(fixture.innerHTML).toBe("87654321");
  });

  test("some permutation [0,1,2,3,4,5] => [4,3,2,1,5,0]", () => {
    const tree = list([0, 1, 2, 3, 4, 5].map(n));
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("012345");

    patch(tree, list([4, 3, 2, 1, 5, 0].map(n)));
    expect(fixture.innerHTML).toBe("432150");
  });

  test("object keys are matched by identity: [A,B,C,D] => [C,A,D,B]", () => {
    const [a, b, c, d] = ["A", "B", "C", "D"].map((name) => ({ name }));
    const items = (keys: { name: string }[]) => keys.map((k) => kSpan(k.name, k));
    const tree = list(items([a, b, c, d]));
    mount(tree, fixture);
    const spans = [...fixture.children];
    expect(fixture.textContent).toBe("ABCD");

    patch(tree, list(items([c, a, d, b])));
    expect(fixture.textContent).toBe("CADB");
    expect([...fixture.children]).toEqual([spans[2], spans[0], spans[3], spans[1]]);
  });

  test("keys that stringify alike stay distinct: [9,1,'1',0] => ['1',8,1,7]", () => {
    const tree = list([kSpan("n9", 9), kSpan("n1", 1), kSpan("s1", "1"), kSpan("n0", 0)]);
    mount(tree, fixture);
    const [, n1, s1] = [...fixture.children];

    patch(tree, list([kSpan("s1", "1"), kSpan("n8", 8), kSpan("n1", 1), kSpan("n7", 7)]));
    expect(fixture.textContent).toBe("s1n8n1n7");
    const children = [...fixture.children];
    expect(children[0]).toBe(s1);
    expect(children[2]).toBe(n1);
  });

  test("a key repeated in the new list mounts the repeat: [x,a,y] => [a,a,z]", () => {
    const tree = list([kSpan("x", "x"), kSpan("a", "a"), kSpan("y", "y")]);
    mount(tree, fixture);
    const a = fixture.children[1];

    patch(tree, list([kSpan("a1", "a"), kSpan("a2", "a"), kSpan("z", "z")]));
    expect(fixture.textContent).toBe("a1a2z");
    expect(fixture.children[0]).toBe(a);

    patch(tree, list([kSpan("z", "z"), kSpan("a", "a")]));
    expect(fixture.textContent).toBe("za");
  });

  test("a list mounted by a patch into an only-child slot is an only child", () => {
    const block = createBlock("<div><block-child-0/></div>");
    const tree = block([], []);
    mount(tree, fixture);
    const items = list([1, 2].map(n));
    patch(tree, block([], [items]));
    expect(fixture.innerHTML).toBe("<div>12</div>");
    expect(items.isOnlyChild).toBe(true);

    patch(tree, block([], [list([])]));
    expect(fixture.innerHTML).toBe("<div></div>");
  });
});

describe("repeated keys", () => {
  const item = createBlock("<span><block-text-0/></span>");
  function items(keys: string[], tag: string): VNode {
    return list(keys.map((key, i) => withKey(item([`${key}${tag}${i}`]), key)));
  }
  function expected(keys: string[], tag: string): string {
    return keys.map((key, i) => `<span>${key}${tag}${i}</span>`).join("");
  }

  test("an old child a start match consumed is not taken again for a repeated key", () => {
    const tree = items(["p", "a", "q"], "o");
    mount(tree, fixture);
    patch(tree, items(["r", "p", "p", "z"], "n"));
    expect(fixture.innerHTML).toBe(expected(["r", "p", "p", "z"], "n"));
    patch(tree, items(["p", "z"], "u"));
    expect(fixture.innerHTML).toBe(expected(["p", "z"], "u"));
  });

  test("random lists with repeated keys patch to what a fresh mount gives", () => {
    let seed = 999;
    const random = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const keys = (repeat: boolean) => {
      const result: string[] = [];
      const length = random(7);
      while (result.length < length) {
        const key = "abcdefg"[random(repeat ? 4 : 7)];
        if (repeat || !result.includes(key)) {
          result.push(key);
        }
      }
      return result;
    };
    const failures: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const [k1, k2, k3] = [keys(true), keys(true), keys(false)];
      const host = document.createElement("div");
      fixture.appendChild(host);
      const tree = items(k1, "o");
      if (i % 2) {
        // a list in a mixed parent, not cleared in bulk
        host.appendChild(document.createElement("i"));
      }
      mount(tree, host);
      const html = () => host.innerHTML.replace("<i></i>", "");
      const steps = `${k1.join("")}>${k2.join("")}>${k3.join("")}`;
      try {
        patch(tree, items(k2, "n"));
        if (html() !== expected(k2, "n")) {
          failures.push(`${steps}: ${html()}`);
          continue;
        }
        patch(tree, items(k3, "u"));
        if (html() !== expected(k3, "u")) {
          failures.push(`${steps}, then: ${html()}`);
        }
      } catch (e: any) {
        failures.push(`${steps}: ${e.message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
