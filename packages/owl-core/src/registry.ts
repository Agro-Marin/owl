import { computed } from "./computed";
import { batch, untrack, type ReadonlyReactiveValue } from "./computations";
import { OwlError } from "./owl_error";
import { signal } from "./signal";
import { DEFAULT_SEQUENCE, type ResourceAddOptions } from "./resource";
import { useScope } from "./scope";
import { type Schema } from "./types";
import { assertType } from "./validation";

interface RegistryOptions<V> {
  name?: string;
  validation?: Schema<V>;
}

interface RegistryAddOptions extends ResourceAddOptions {
  force?: boolean;
}

type Entry<V> = [sequence: number, value: V, order: number];

export class Registry<V> {
  private _map = signal.Object<Record<string, Entry<V>>>(Object.create(null));
  private _order = 0;
  private _name: string;
  private _validation?: Schema<V>;
  private _overwritten = new WeakMap<Entry<V>, Entry<V>>();
  private _ended = new WeakSet<Entry<V>>();

  constructor(options: RegistryOptions<V> = {}) {
    this._name = options.name || "registry";
    this._validation = options.validation;
  }

  entries: ReadonlyReactiveValue<[string, V][]> = computed(
    () => {
      const entries: [string, V][] = Object.entries(this._map())
        .sort((el1, el2) => el1[1][0] - el2[1][0] || el1[1][2] - el2[1][2])
        .map(([str, elem]) => [str, elem[1]]);
      return entries;
    },
    { detached: true }
  );

  items: ReadonlyReactiveValue<V[]> = computed(() => this.entries().map((e) => e[1]), {
    detached: true,
  });

  addById<U extends { id: string } & V>(item: U, options: RegistryAddOptions = {}): Registry<V> {
    return this.add(this._getId(item), item, options);
  }

  add(key: string, value: V, options: RegistryAddOptions = {}): Registry<V> {
    this._add(key, value, options);
    return this;
  }

  private _getId(item: { id: string }): string {
    return untrack(() => {
      const id = item.id;
      if (!id) {
        throw new OwlError(`Item should have an id key (registry '${this._name}')`);
      }
      return id;
    });
  }

  private _assertCanAdd(key: string, force: boolean | undefined): void {
    if (!force && key in this._map()) {
      throw new OwlError(
        `Key "${key}" is already registered (registry '${this._name}'). Use { force: true } to overwrite.`
      );
    }
  }

  private _add(
    key: string,
    value: V,
    options: RegistryAddOptions,
    register?: (entry: Entry<V>, previous: Entry<V> | undefined) => void
  ): Entry<V> {
    return untrack(() => {
      const force = options.force;
      this._assertCanAdd(key, force);
      if (this._validation) {
        assertType(
          value,
          this._validation,
          `Registry entry does not match the type (registry '${this._name}', key: '${key}')`
        );
      }
      const sequence = options.sequence ?? DEFAULT_SEQUENCE;
      this._assertCanAdd(key, force);
      const map = this._map();
      const previous = map[key];
      const order = previous ? previous[2] : this._order++;
      const entry: Entry<V> = [sequence, value, order];
      map[key] = entry;
      register?.(entry, previous);
      return entry;
    });
  }

  get(key: string): V;
  get<D>(key: string, defaultValue: D): V | D;
  get(key: string, defaultValue?: unknown): unknown {
    const hasKey = key in this._map();
    if (!hasKey && arguments.length < 2) {
      throw new OwlError(`Cannot find key "${key}" (registry '${this._name}')`);
    }
    return hasKey ? this._map()[key][1] : defaultValue;
  }

  delete(key: string): Registry<V> {
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

  use(key: string, value: V, options: RegistryAddOptions = {}): Registry<V> {
    const scope = useScope();
    batch(() => {
      this._add(key, value, options, (entry, previous) => {
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
      });
    });
    return this;
  }

  useById<U extends { id: string } & V>(item: U, options: RegistryAddOptions = {}): Registry<V> {
    return this.use(this._getId(item), item, options);
  }
}
