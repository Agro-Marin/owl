import { computed } from "./computed";
import { untrack, type ReadonlyReactiveValue } from "./computations";
import { OwlError } from "./owl_error";
import { signal } from "./signal";
import { ResourceAddOptions } from "./resource";
import { useScope } from "./scope";
import { type StripBrands } from "./types";
import { assertType } from "./validation";

interface RegistryOptions<T> {
  name?: string;
  validation?: T;
}

interface RegistryAddOptions extends ResourceAddOptions {
  force?: boolean;
}

// T is the validation type; entries carry the value type it describes.
type Item<T> = StripBrands<T>;
type Entry<T> = [sequence: number, value: Item<T>, order: number];

export class Registry<T> {
  private _map = signal.Object<Record<string, Entry<T>>>(Object.create(null));
  private _order = 0;
  private _name: string;
  private _validation?: T;
  // the entry a use() overwrote, put back when that use() ends, and the use()
  // entries that ended: a restore skips them
  private _overwritten = new WeakMap<Entry<T>, Entry<T>>();
  private _ended = new WeakSet<Entry<T>>();

  constructor(options: RegistryOptions<T> = {}) {
    this._name = options.name || "registry";
    this._validation = options.validation;
  }

  entries: ReadonlyReactiveValue<[string, Item<T>][]> = computed(
    () => {
      const entries: [string, Item<T>][] = Object.entries(this._map())
        .sort((el1, el2) => el1[1][0] - el2[1][0] || el1[1][2] - el2[1][2])
        .map(([str, elem]) => [str, elem[1]]);
      return entries;
    },
    { detached: true }
  );

  items: ReadonlyReactiveValue<Item<T>[]> = computed(() => this.entries().map((e) => e[1]), {
    detached: true,
  });

  addById<U extends { id: string } & Item<T>>(
    item: U,
    options: RegistryAddOptions = {}
  ): Registry<T> {
    if (!item.id) {
      throw new OwlError(`Item should have an id key (registry '${this._name}')`);
    }
    return this.add(item.id, item, options);
  }

  add(key: string, value: Item<T>, options: RegistryAddOptions = {}): Registry<T> {
    this._add(key, value, options);
    return this;
  }

  private _add(key: string, value: Item<T>, options: RegistryAddOptions): Entry<T> {
    if (!options.force && untrack(() => key in this._map())) {
      throw new OwlError(
        `Key "${key}" is already registered (registry '${this._name}'). Use { force: true } to overwrite.`
      );
    }
    if (this._validation) {
      assertType(
        value,
        this._validation,
        `Registry entry does not match the type (registry '${this._name}', key: '${key}')`
      );
    }
    return untrack(() => {
      const map = this._map();
      const order = key in map ? map[key][2] : this._order++;
      const entry: Entry<T> = [options.sequence ?? 50, value, order];
      map[key] = entry;
      return entry;
    });
  }

  get(key: string, defaultValue?: Item<T>): Item<T> {
    const hasKey = key in this._map();
    if (!hasKey && arguments.length < 2) {
      throw new OwlError(`Cannot find key "${key}" (registry '${this._name}')`);
    }
    return hasKey ? this._map()[key][1] : defaultValue!;
  }

  delete(key: string): Registry<T> {
    untrack(() => {
      delete this._map()[key];
    });
    return this;
  }

  clear() {
    this._map.set(Object.create(null));
  }

  has(key: string): boolean {
    return key in this._map();
  }

  use(key: string, value: Item<T>, options: RegistryAddOptions = {}): Registry<T> {
    const scope = useScope();
    const previous = untrack(() => this._map()[key]);
    const entry = this._add(key, value, options);
    if (previous) {
      this._overwritten.set(entry, previous);
    }
    scope.onDestroy(() => {
      this._ended.add(entry);
      untrack(() => {
        const map = this._map();
        if (map[key] !== entry) {
          return;
        }
        let restored = this._overwritten.get(entry);
        while (restored && this._ended.has(restored)) {
          restored = this._overwritten.get(restored);
        }
        if (restored) {
          map[key] = restored;
        } else {
          delete map[key];
        }
      });
    });
    return this;
  }

  useById<U extends { id: string } & Item<T>>(
    item: U,
    options: RegistryAddOptions = {}
  ): Registry<T> {
    if (!item.id) {
      throw new OwlError(`Item should have an id key (registry '${this._name}')`);
    }
    return this.use(item.id, item, options);
  }
}
