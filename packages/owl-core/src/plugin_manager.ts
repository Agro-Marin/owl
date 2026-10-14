import { debug, debugLog } from "./debug";
import { effect } from "./effect";
import { OwlError } from "./owl_error";
import { Resource } from "./resource";
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

  static sequence = 50;

  __owl__: PluginManager;

  constructor(manager: PluginManager) {
    this.__owl__ = manager;
  }

  setup() {}
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
    return this.getPluginById<InstanceType<T>>(pluginConstructor.id);
  }

  startPlugin<T extends PluginConstructor>(pluginConstructor: T): InstanceType<T> | null {
    const id = pluginConstructor.id;
    if (!id) {
      throw new OwlError(`Plugin "${pluginConstructor.name}" has no id`);
    }

    if (Object.hasOwn(this.plugins, id)) {
      const existingPluginType = this.plugins[id].constructor;
      if (existingPluginType !== pluginConstructor) {
        throw new OwlError(
          `Trying to start a plugin with the same id as an other plugin (id: '${id}', existing plugin: '${existingPluginType.name}', starting plugin: '${pluginConstructor.name}')`
        );
      }
      return null;
    }
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
    try {
      plugin = new pluginConstructor(this);
      this.plugins[id] = plugin;
      this.startedIds.push(id);
      plugin.setup();
    } catch (e) {
      if (debug.plugin) {
        debugLog("plugin", `start of ${id} failed, undo`, this.startedIds.slice(startedMark));
      }
      for (const startedId of this.startedIds.splice(startedMark)) {
        delete this.plugins[startedId];
      }
      this.rollback(mark, (e) => console.error(e));
      throw e;
    } finally {
      this.startingPath.pop();
    }
    this.pending.delete(id);
    return plugin as InstanceType<T>;
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
    for (let manager: PluginManager | null = this; manager; manager = manager.parent) {
      if (manager.pending.has(id)) {
        return true;
      }
      if (Object.hasOwn(manager.plugins, id)) {
        return false;
      }
    }
    return false;
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
    if (!fresh.length) {
      return;
    }
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
    for (const batch of batches.slice(1)) {
      for (const ctor of batch) {
        this.pending.set(ctor.id, ctor);
      }
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

    let chain: Promise<unknown> | null = this.hasPendingReady ? this.ready : null;
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
        if (this.status < STATUS.MOUNTED) {
          this.status = STATUS.MOUNTED;
        }
        if (this.ready === ready) {
          this.hasPendingReady = false;
        }
      },
      (e) => {
        if (debug.plugin) {
          debugLog("plugin", "start failed, later batches skipped", e);
        }
        this.pending.clear();
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
    manager.onDestroy(effect(() => manager.startPlugins(plugins.items())));
  }
}
