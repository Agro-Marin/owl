import { mount, patch } from "../../src/blockdom";
import { makeTestFixture, renderToBdom, renderToString } from "../helpers";
import { CONTEXT, UPDATED, canonical, generator, prng, render, toXml } from "./template_fuzz_lib";

// Random templates rendered by owl must serialize to what the reference
// renderer renders, at first and once patched to other values (see
// template_fuzz_lib.ts; template_fuzz_interactive.test.ts mounts them as
// components and dispatches events)

const COUNT = Number(process.env.OWL_TEMPLATE_FUZZ || 400);

test(
  "random templates render what the reference renderer renders",
  () => {
    const next = generator(prng(5));
    const failures: string[] = [];
    for (let i = 0; i < COUNT && failures.length < 3; i++) {
      const { tree } = next();
      const template = `<div>${toXml(tree)}</div>`;
      const expected = `<div>${render(tree, CONTEXT)}</div>`;
      let actual: string;
      try {
        actual = renderToString(template, { ...CONTEXT });
      } catch (error: any) {
        actual = `throws ${error.message}`;
      }
      if (actual !== expected) {
        failures.push(`${template}\n  owl ${actual}\n  ref ${expected}`);
      }
    }
    expect(failures).toEqual([]);
  },
  Math.max(120000, COUNT * 100)
);

test(
  "random templates patched to other values render what the reference renders for them",
  () => {
    const next = generator(prng(17));
    const failures: string[] = [];
    for (let i = 0; i < COUNT && failures.length < 3; i++) {
      const { tree } = next();
      const template = `<div>${toXml(tree)}</div>`;
      let actual: string;
      try {
        const fixture = makeTestFixture();
        const first = renderToBdom(template, { ...CONTEXT });
        mount(first, fixture);
        patch(first, renderToBdom(template, { ...UPDATED }));
        const back = canonical(fixture.innerHTML);
        patch(first, renderToBdom(template, { ...CONTEXT }));
        actual = `${back} | ${canonical(fixture.innerHTML)}`;
      } catch (error: any) {
        actual = `throws ${error.message}`;
      }
      const expected = `${canonical(`<div>${render(tree, UPDATED)}</div>`)} | ${canonical(`<div>${render(tree, CONTEXT)}</div>`)}`;
      if (actual !== expected) {
        failures.push(`${template}\n  owl ${actual}\n  ref ${expected}`);
      }
    }
    expect(failures).toEqual([]);
  },
  Math.max(120000, COUNT * 100)
);
