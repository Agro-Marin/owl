import { debug, debugLog } from "./debug";
import { effect } from "./effect";
import { OwlError } from "./owl_error";
import { DEFAULT_SEQUENCE, Resource } from "./resource";
import { isAbortError, Scope, scopeStack, type ScopeApp } from "./scope";
import { STATUS } from "./status";
import { untrack } from "./computations";

export interface PluginConstructor {
  new (...args: any[]): Plugin;
  id: string;
  sequence: number;
  scoped?(plugin: any, scope: Scope): object;
}

export class Plugin {
  static get id(): string {
    return this.name;
  }

  static sequence = DEFAULT_SEQUENCE;

  __owl__: PluginManager;

  constructor(manager: PluginManager) {
    this.__owl__ = manager;
  }

  setup() {}
}

function hasDeclaredId(pluginType: Function): boolean {
  for (let type: any = pluginType; type && type !== Plugin; type = Object.getPrototypeOf(type)) {
    if (Object.hasOwn(type, "id")) {
      return true;
    }
  }
  return false;
}

export function isPluginOf(plugin: Plugin, pluginType: Function): boolean {
  return plugin instanceof pluginType || hasDeclaredId(pluginType);
}

interface PluginManagerOptions {
  parent?: PluginManager | null;
  config?: object;
}

export class PluginManager<TApp extends ScopeApp = ScopeApp> extends Scope<TApp> {
  config: Record<string, unknown>;
  plugins: Record<string, Plugin>;
  parent: PluginManager | null;

  ready: Promise<void> = Promise.resolve();
  private hasPendingReady = false;
  private pending = new Map<string, PluginConstructor>();
  private startingPath: PluginConstructor[] = [];
  private startedIds: string[] = [];
  private destroyGroups: Array<Array<() => void>> = [];

  constructor(app: TApp, options: PluginManagerOptions = {}) {
    super(app);
    const parent = options.parent ?? null;
    this.parent = parent;
    this.config = parent
      ? Object.assign(Object.create(parent.config), options.config)
      : (options.config ?? {});
    this.pluginManager = this;

    if (parent) {
      this.plugins = Object.create(parent.plugins);
    } else {
      this.plugins = Object.create(null);
    }
  }

  destroy() {
    this.finalize((e) => console.error(e));
  }

  getPluginById<T extends Plugin>(id: string): T | null {
    return (this.plugins[id] as T) || null;
  }

  getPlugin<T extends PluginConstructor>(pluginConstructor: T): InstanceType<T> | null {
    const id = pluginConstructor.id;
    for (let manager: PluginManager | null = this; manager; manager = manager.parent) {
      if (Object.hasOwn(manager.plugins, id)) {
        const plugin = manager.plugins[id] as InstanceType<T>;
        if (isPluginOf(plugin, pluginConstructor)) {
          return plugin;
        }
        if (debug.plugin) {
          debugLog("plugin", `${id} here is another class, looking further up`);
        }
      }
    }
    return null;
  }

  onDestroy(cb: () => void): void {
    const group = this.destroyGroups[this.destroyGroups.length - 1];
    if (group && this.status < STATUS.DESTROYED) {
      group.push(cb);
    } else {
      super.onDestroy(cb);
    }
  }

  private flushDestroyGroup(): void {
    for (const cb of this.destroyGroups.pop()!) {
      super.onDestroy(cb);
    }
  }

  private assertAlive(pluginConstructor: Function): void {
    if (this.status >= STATUS.DESTROYED) {
      throw new OwlError(
        `Cannot start plugin "${(pluginConstructor as PluginConstructor).id}": its plugin manager is destroyed`
      );
    }
  }

  startPlugin<T extends PluginConstructor>(pluginConstructor: T): InstanceType<T> | null {
    const id = pluginConstructor.id;
    if (!id) {
      throw new OwlError(`Plugin "${pluginConstructor.name}" has no id`);
    }

    if (Object.hasOwn(this.plugins, id)) {
      if (this.plugins[id].constructor !== pluginConstructor) {
        this.throwDuplicate(id, pluginConstructor);
      }
      return null;
    }
    this.assertAlive(pluginConstructor);
    this.assertNotStarting(pluginConstructor);

    const mark = this.mark();
    const startedMark = this.startedIds.length;
    if (debug.plugin) {
      debugLog(
        "plugin",
        `start ${id}`,
        this.startingPath.map((ctor) => ctor.id)
      );
    }
    let plugin: Plugin;
    this.startingPath.push(pluginConstructor);
    this.destroyGroups.push([]);
    scopeStack.push(this);
    try {
      plugin = untrack(() => new pluginConstructor(this));
      if (Object.hasOwn(this.plugins, id)) {
        this.throwDuplicate(id, pluginConstructor);
      }
      this.plugins[id] = plugin;
      this.startedIds.push(id);
      untrack(() => plugin.setup());
    } catch (e) {
      if (debug.plugin) {
        debugLog("plugin", `start of ${id} failed, undo`, this.startedIds.slice(startedMark));
      }
      for (const startedId of this.startedIds.splice(startedMark)) {
        delete this.plugins[startedId];
      }
      this.flushDestroyGroup();
      this.rollback(mark, (e) => console.error(e));
      throw e;
    } finally {
      scopeStack.pop();
      this.startingPath.pop();
    }
    this.flushDestroyGroup();
    if (!this.startingPath.length) {
      this.startedIds.length = 0;
    }
    this.pending.delete(id);
    return plugin as InstanceType<T>;
  }

  private throwDuplicate(id: string, pluginConstructor: Function): never {
    throw new OwlError(
      `Trying to start a plugin with the same id as an other plugin (id: '${id}', existing plugin: '${this.plugins[id].constructor.name}', starting plugin: '${pluginConstructor.name}')`
    );
  }

  isStarting(pluginConstructor: Function): boolean {
    return this.startingPath.includes(pluginConstructor as PluginConstructor);
  }

  assertNotStarting(pluginConstructor: Function): void {
    const index = this.startingPath.indexOf(pluginConstructor as PluginConstructor);
    if (index !== -1) {
      const path = [...this.startingPath.slice(index), pluginConstructor as PluginConstructor];
      const ids = path.map((ctor) => ctor.id).join(" -> ");
      if (debug.plugin) {
        debugLog("plugin", `circular dependency ${ids}`);
      }
      throw new OwlError(`Circular plugin dependency: ${ids}`);
    }
  }

  isPending(id: string): boolean {
    return this.pendingIn(id) !== null;
  }

  pendingIn(id: string): PluginManager | null {
    for (let manager: PluginManager | null = this; manager; manager = manager.parent) {
      if (manager.pending.has(id)) {
        return manager;
      }
      if (Object.hasOwn(manager.plugins, id)) {
        return null;
      }
    }
    return null;
  }

  private collect<T>(fn: () => T): T {
    const collecting = this.collectingWillStart;
    this.collectingWillStart = true;
    scopeStack.push(this);
    try {
      return untrack(fn);
    } finally {
      scopeStack.pop();
      this.collectingWillStart = collecting;
    }
  }

  startPlugins(pluginConstructors: PluginConstructor[]): void {
    const fresh = pluginConstructors.filter((ctor) => {
      if (!ctor.id || Object.hasOwn(this.plugins, ctor.id)) {
        this.startPlugin(ctor);
        return false;
      }
      return true;
    });
    const nested = this.collectingWillStart;
    if (!fresh.length) {
      if (!nested && !this.hasPendingReady && this.status < STATUS.MOUNTED) {
        this.status = STATUS.MOUNTED;
      }
      return;
    }
    this.assertAlive(fresh[0]);
    fresh.sort((p1, p2) => p1.sequence - p2.sequence);
    const batches: PluginConstructor[][] = [];
    for (const ctor of fresh) {
      const batch = batches[batches.length - 1];
      if (batch && batch[0].sequence === ctor.sequence) {
        batch.push(ctor);
      } else {
        batches.push([ctor]);
      }
    }
    const readyBefore = this.ready;
    let chain: Promise<unknown> | null = !nested && this.hasPendingReady ? this.ready : null;
    for (const ctor of fresh) {
      this.pending.set(ctor.id, ctor);
    }

    const startBatch = (batch: PluginConstructor[]): Promise<unknown> | null => {
      if (this.status >= STATUS.DESTROYED) {
        return null;
      }
      if (debug.plugin) {
        debugLog(
          "plugin",
          `batch of sequence ${batch[0].sequence}`,
          batch.map((ctor) => ctor.id)
        );
      }
      return this.collect(() => {
        for (const ctor of batch) {
          this.pending.delete(ctor.id);
          this.startPlugin(ctor);
        }
        const pending = this.willStart.splice(0);
        if (debug.plugin && pending.length) {
          debugLog("plugin", `batch of sequence ${batch[0].sequence}: ${pending.length} willStart`);
        }
        return pending.length ? Promise.all(pending.map((fn) => fn())) : null;
      });
    };

    try {
      for (const batch of batches) {
        if (chain) {
          chain = chain.then(() => startBatch(batch));
        } else {
          chain = startBatch(batch);
        }
      }
    } catch (e) {
      const dropped = fresh.filter((ctor) => this.pending.get(ctor.id) === ctor);
      for (const ctor of dropped) {
        this.pending.delete(ctor.id);
      }
      if (debug.plugin && dropped.length) {
        debugLog(
          "plugin",
          "start failed, later batches dropped",
          dropped.map((ctor) => ctor.id)
        );
      }
      throw e;
    }
    if (nested) {
      if (chain) {
        if (debug.plugin) {
          debugLog("plugin", "a start nested in a batch is pending, the batch waits for it");
        }
        const nestedChain = chain;
        this.willStart.push(() => nestedChain);
      }
      return;
    }
    if (this.ready !== readyBefore && this.hasPendingReady) {
      if (debug.plugin) {
        debugLog("plugin", "a start nested in this one is pending, ready waits for it");
      }
      chain = chain ? Promise.all([chain, this.ready]) : this.ready;
    }
    if (!chain) {
      if (this.status < STATUS.MOUNTED) {
        this.status = STATUS.MOUNTED;
      }
      return;
    }
    this.hasPendingReady = true;
    const ready = (this.ready = chain.then(
      () => {
        if (debug.plugin) {
          debugLog("plugin", "ready");
        }
        if (this.ready === ready) {
          this.hasPendingReady = false;
          if (this.status < STATUS.MOUNTED) {
            this.status = STATUS.MOUNTED;
          }
        }
      },
      (e) => {
        if (debug.plugin) {
          debugLog("plugin", "start failed, later batches skipped", e);
        }
        this.pending.clear();
        if (this.ready === ready) {
          this.hasPendingReady = false;
        }
        if (this.status >= STATUS.DESTROYED) {
          if (debug.plugin) {
            debugLog(
              "plugin",
              `${isAbortError(e) ? "abort" : "failure"} after destroy, dropped`,
              e
            );
          }
          return;
        }
        throw e;
      }
    ));
  }
}

export function startPlugins(
  manager: PluginManager,
  plugins: PluginConstructor[] | Resource<PluginConstructor>
) {
  if (Array.isArray(plugins)) {
    manager.startPlugins(plugins);
  } else {
    manager.onDestroy(
      effect(() => manager.startPlugins(plugins.items()), {
        detached: true,
      })
    );
  }
}
