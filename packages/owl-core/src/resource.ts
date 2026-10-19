import { computed } from "./computed";
import { batch, untrack, type ReadonlyReactiveValue } from "./computations";
import { signal } from "./signal";
import { useScope } from "./scope";
import { type Schema } from "./types";
import { assertType } from "./validation";

interface ResourceOptions<V> {
  name?: string;
  validation?: Schema<V>;
}

export const DEFAULT_SEQUENCE = 50;

export interface ResourceAddOptions {
  sequence?: number;
}

type Entry<V> = [sequence: number, item: V];

export class Resource<V> {
  private _items = signal.Array<Entry<V>>([]);
  private _name?: string;
  private _validation?: Schema<V>;

  constructor(options: ResourceOptions<V> = {}) {
    this._name = options.name;
    this._validation = options.validation;
  }

  items: ReadonlyReactiveValue<V[]> = computed(
    () => {
      return [...this._items()].sort((el1, el2) => el1[0] - el2[0]).map((elem) => elem[1]);
    },
    { detached: true }
  );

  add(item: V, options: ResourceAddOptions = {}): Resource<V> {
    this._add(item, options);
    return this;
  }

  private _add(item: V, options: ResourceAddOptions): Entry<V> {
    return untrack(() => {
      if (this._validation) {
        const info = this._name ? ` (resource '${this._name}')` : "";
        assertType(item, this._validation, `Resource item does not match the type${info}`);
      }
      const entry: Entry<V> = [options.sequence ?? DEFAULT_SEQUENCE, item];
      this._items().push(entry);
      return entry;
    });
  }

  delete(item: V): Resource<V> {
    this._remove((entry) => entry[1] === item);
    return this;
  }

  private _remove(match: (entry: Entry<V>) => boolean): void {
    untrack(() => {
      const entries = this._items();
      if (entries.some(match)) {
        this._items.set(entries.filter((entry) => !match(entry)));
      }
    });
  }

  clear() {
    this._items.set([]);
  }

  has(item: V): boolean {
    return this._items().some(([s, value]) => value === item);
  }

  use(item: V, options: ResourceAddOptions = {}): Resource<V> {
    const scope = useScope();
    batch(() => {
      const entry = this._add(item, options);
      scope.onDestroy(() => this._remove((e) => e === entry));
    });
    return this;
  }
}
