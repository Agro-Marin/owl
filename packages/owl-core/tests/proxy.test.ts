import v8 from "node:v8";
import vm from "node:vm";
import { effect, proxy } from "../src";

v8.setFlagsFromString("--expose-gc");
const gc: () => void = vm.runInNewContext("gc");

async function collectGarbage() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
}

describe("memory", () => {
  test("a reactive WeakMap read by an effect does not keep its keys alive", async () => {
    const map = proxy(new WeakMap<object, number>());
    let key: object | null = {};
    const ref = new WeakRef(key);
    map.set(key, 1);
    const dispose = effect(() => map.get(key!));
    dispose();
    key = null;
    await collectGarbage();
    expect(ref.deref()).toBeUndefined();
  });

  test("a reactive Map does not keep the object keys it deleted alive", async () => {
    const map = proxy(new Map<object, number>());
    const refs: WeakRef<object>[] = [];
    for (let i = 0; i < 10; i++) {
      const key = { i };
      refs.push(new WeakRef(key));
      map.set(key, i);
      effect(() => map.get(key))();
      map.delete(key);
    }
    await collectGarbage();
    expect(refs.filter((ref) => ref.deref())).toEqual([]);
  });
});
