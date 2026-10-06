import { computed, markRaw, proxy, readArrayItems, signal, toRaw } from "../src";

function itemsReader<T>(array: T[]) {
  let runs = 0;
  const read = computed(
    () => {
      runs++;
      return readArrayItems(array).slice();
    },
    { detached: true }
  );
  return { read, runs: () => runs };
}

describe("readArrayItems", () => {
  test("hands out the items a read through the proxy would", () => {
    const inner = { id: 1 };
    const array = proxy([inner, 2, "a", null]);
    const items = readArrayItems(array);
    expect(items).not.toBe(array);
    expect(items[0]).toBe(array[0]);
    expect(toRaw(items[0] as object)).toBe(inner);
    expect(items.slice(1)).toEqual([2, "a", null]);
  });

  test("keeps a raw array, a collection signal's value and a raw-marked item as they are", () => {
    const raw = [{ id: 1 }];
    expect(readArrayItems(raw)).toBe(raw);
    const list = signal.Array([{ id: 1 }]);
    expect(readArrayItems(list())).toBe(list());
    const kept = markRaw({ id: 2 });
    const array = proxy([kept]);
    void array[0];
    expect(readArrayItems(array)[0]).toBe(kept);
  });

  test("leaves a subclass of Array, which may answer its index reads from elsewhere, to be read as usual", () => {
    class Indexed extends Array<string> {
      store = proxy({ items: [] as string[] });
    }
    const list = new Indexed();
    const view = proxy(
      new Proxy(list, {
        get(target, key, receiver) {
          if (key === "length") {
            return Reflect.get(target, "store", receiver).items.length;
          }
          if (typeof key === "string" && /^\d+$/.test(key)) {
            return Reflect.get(target, "store", receiver).items[Number(key)];
          }
          return Reflect.get(target, key, receiver);
        },
      })
    );
    expect(readArrayItems(view)).toBe(view);
    const read = computed(() => [...readArrayItems(view)].join(","), { detached: true });
    list.store.items.push("a");
    expect(read()).toBe("a");
    list.store.items.push("b");
    expect(read()).toBe("a,b");
  });

  test("hands out a frozen array's items raw, as its get trap must", () => {
    const item = { id: 1 };
    const array = proxy(Object.freeze([item]) as { id: number }[]);
    expect(array[0]).toBe(item);
    expect(readArrayItems(array)[0]).toBe(item);
  });

  test("one read subscribes to every write of an index or of the length", () => {
    const array = proxy([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const { read, runs } = itemsReader(array);
    expect(read().map((r) => r.id)).toEqual([1, 2, 3]);
    array[1] = { id: 20 };
    expect(read().map((r) => r.id)).toEqual([1, 20, 3]);
    array.push({ id: 4 });
    expect(read().map((r) => r.id)).toEqual([1, 20, 3, 4]);
    array.splice(0, 1);
    expect(read().map((r) => r.id)).toEqual([20, 3, 4]);
    array.reverse();
    expect(read().map((r) => r.id)).toEqual([4, 3, 20]);
    array.length = 1;
    expect(read().map((r) => r.id)).toEqual([4]);
    delete (array as any)[0];
    expect(read()).toEqual([undefined]);
    array[3] = { id: 9 };
    expect(read().length).toBe(4);
    expect(runs()).toBe(8);
  });

  test("a write that changes nothing, or a change inside an item, does not notify it", () => {
    const first = { id: 1 };
    const array = proxy([first]);
    const { read, runs } = itemsReader(array);
    read();
    array[0] = first;
    array[0].id = 2;
    read();
    expect(runs()).toBe(1);
  });
});
