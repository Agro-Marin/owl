import { computed } from "./computed";
import { untrack, type ReactiveValue } from "./computations";
import { signal } from "./signal";
import { useScope } from "./scope";
import { type StripBrands } from "./types";
import { assertType } from "./validation";

interface ResourceOptions<T> {
  name?: string;
  validation?: T;
}

export interface ResourceAddOptions {
  sequence?: number;
}

// T is the validation type; items carry the value type it describes.
type Item<T> = StripBrands<T>;
type Entry<T> = [sequence: number, item: Item<T>];

export class Resource<T> {
  private _items = signal.Array<Entry<T>>([]);
  private _name?: string;
  private _validation?: T;

  constructor(options: ResourceOptions<T> = {}) {
    this._name = options.name;
    this._validation = options.validation;
  }

  items: ReactiveValue<Item<T>[]> = computed(
    () => {
      return [...this._items()].sort((el1, el2) => el1[0] - el2[0]).map((elem) => elem[1]);
    },
    { detached: true }
  );

  add(item: Item<T>, options: ResourceAddOptions = {}): Resource<T> {
    this._add(item, options);
    return this;
  }

  private _add(item: Item<T>, options: ResourceAddOptions): Entry<T> {
    if (this._validation) {
      const info = this._name ? ` (resource '${this._name}')` : "";
      assertType(item, this._validation, `Resource item does not match the type${info}`);
    }
    const entry: Entry<T> = [options.sequence ?? 50, item];
    untrack(() => {
      this._items().push(entry);
    });
    return entry;
  }

  delete(item: Item<T>): Resource<T> {
    this._remove((entry) => entry[1] === item);
    return this;
  }

  private _remove(match: (entry: Entry<T>) => boolean): void {
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

  has(item: Item<T>): boolean {
    return this._items().some(([s, value]) => value === item);
  }

  use(item: Item<T>, options: ResourceAddOptions = {}): Resource<T> {
    const scope = useScope();
    const entry = this._add(item, options);
    scope.onDestroy(() => this._remove((e) => e === entry));
    return this;
  }
}
