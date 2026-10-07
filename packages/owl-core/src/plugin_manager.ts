import { debug, debugLog } from "./debug";
import { effect } from "./effect";
import { OwlError } from "./owl_error";
import { Resource } from "./resource";
import { isAbortError, Scope, scopeStack } from "./scope";
import { STATUS } from "./status";
import { untrack } from "./computations";

export interface PluginConstructor {
  new (...args: any[]): Plugin;
  id: string;
  sequence: number;
  /**
   * Optional factory producing a specialized view of the plugin for a
   * consumer scope. When defined, `usePlugin` returns
   * `scoped(plugin, scope)` instead of the plugin itself, where `scope` is
   * the caller's scope (a component node or a plugin manager). Typical use:
   * wrap async methods with `scope.run` so their results are guarded by the
   * consumer's lifetime, and expose the raw instance as an escape hatch:
   *
   * ```ts
   * class ORM extends Plugin {
   *   static scoped(self: ORM, scope: Scope): ORM {
   *     return Object.assign(Object.create(self), {
   *       read: scope.run.bind(scope, self.read),
   *     });
   *   }
   *   unscoped = this;
   *   read = async (...) => { ... };
   * }
   * ```
   *
   * Called once per `usePlugin` call — the returned view is not cached.
   * It is a static (not an instance method) so the scoped view, usually
   * created with `Object.create(plugin)`, does not inherit it.
   */
  scoped?(plugin: any, scope: Scope): object;
}

export class Plugin {
  // A plugin is known by its class name, unless it declares `static id =
  // "..."` (an own property, which a subclass inherits as any static).
  static get id(): string {
    return this.name;
  }

  // Plugins passed to `startPlugins` are started in batches of equal sequence,
  // ascending (lower first), like Resource/Registry. Each batch's onWillStart
  // callbacks fully settle before the next batch is instantiated, so
  // foundational plugins (low sequence) are ready before later plugins even
  // run their setup. Explicit `plugin(X)` dependencies bypass batching and
  // start immediately.
  static sequence = 50;

  __owl__: PluginManager;

  constructor(manager: PluginManager) {
    this.__owl__ = manager;
  }

  setup() {}
}

interface PluginManagerOptions {
  parent?: PluginManager | null;
  config?: Record<string, any>;
}

export class PluginManager extends Scope {
  config: Record<string, any>;
  plugins: Record<string, Plugin>;
  parent: PluginManager | null;

  // Resolves once all batches of plugins have started and their willStart
  // callbacks have settled. The scope transitions to MOUNTED as the last step
  // of this chain. Consumers (the root's mount(), providePlugins) await this
  // before treating the manager as ready. `willStart` itself is inherited
  // from Scope.
  ready: Promise<void> = Promise.resolve();
  private hasPendingReady = false;
  // constructors of the batches still waiting for an earlier batch's
  // willStart, by id, to tell a consumer why the plugin is not there yet
  private pending = new Map<string, PluginConstructor>();
  // plugins being started (constructor or setup), in dependency order: asking
  // for one of them again is a dependency cycle, this the path it reports
  private startingPath: PluginConstructor[] = [];
  // own plugin ids in start order, so a failed setup can unregister what it started
  private startedIds: string[] = [];

  constructor(app: any, options: PluginManagerOptions = {}) {
    super(app);
    const parent = options.parent ?? null;
    this.parent = parent;
    this.config = parent
      ? Object.assign(Object.create(parent.config), options.config)
      : (options.config ?? {});
    this.pluginManager = this;

    if (parent) {
      // The parent deliberately keeps NO reference to this sub manager: an
      // onDestroy callback on the parent is never removed, so a long-lived
      // parent would retain every destroyed sub manager (and all its plugin
      // instances). Whoever creates a sub manager is responsible for
      // destroying it — providePlugins ties it to its host component's
      // lifetime, and the app destroys its own manager.
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
      // undo everything this start registered, including the plugins it
      // started as dependencies, so a failed start leaves nothing behind
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

  /**
   * Whether the plugin of `pluginConstructor` is being started (its
   * constructor or its setup is running).
   */
  isStarting(pluginConstructor: Function): boolean {
    return this.startingPath.includes(pluginConstructor as PluginConstructor);
  }

  /**
   * Throws when the plugin of `pluginConstructor` is being constructed again:
   * its constructor asked, through other plugins, for itself, which does not
   * exist yet. (Asked for while its setup runs, it exists: usePlugin hands it
   * out.)
   */
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

  /**
   * Whether the nearest manager, up the parent chain, that provides `id` has
   * not started it yet: its batch still waits for an earlier batch's
   * onWillStart.
   */
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

  // Runs a batch in this scope, collecting its onWillStart callbacks. Not
  // through run(): its result is returned as is, never guarded as a promise.
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
        // already started (or invalid): startPlugin throws on missing ids and
        // id conflicts, and is a no-op otherwise
        this.startPlugin(ctor);
        return false;
      }
      return true;
    });
    if (!fresh.length) {
      return;
    }
    // Sort ascending by sequence and group plugins of equal sequence into
    // batches. A batch's willStart callbacks all settle before the next batch
    // is even instantiated, so foundational (low sequence) plugins are fully
    // ready before later plugins run their setup.
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

    // Instantiate one batch synchronously (never spanning an await) and
    // return its pending willStart promise, if any. Nothing a plugin reads
    // while starting subscribes the caller, which may be an effect.
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

    // Chain onto a still-pending `ready` (re-entrant call, e.g. a plugin added
    // to a Resource while startup is in flight) so new plugins wait for the
    // previous batches.
    let chain: Promise<unknown> | null = this.hasPendingReady ? this.ready : null;
    try {
      for (const batch of batches) {
        if (chain) {
          // Later batches are instantiated inside the previous batch's `then` so
          // that a rejection skips them entirely.
          chain = chain.then(() => startBatch(batch));
        } else {
          // No async work pending so far: start the batch synchronously.
          chain = startBatch(batch);
        }
      }
    } catch (e) {
      // a batch started synchronously failed: the later ones never start
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
        // Fast path: no async init, transition synchronously so consumers that
        // read `status` right after `startPlugins` see MOUNTED immediately.
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
        // Once the manager is destroyed nobody waits for its plugins: an
        // onWillStart failing then (aborted or not) is dropped and `ready`
        // resolves, as for a destroyed component's hooks. A failure of a live
        // manager keeps `ready` rejected and `hasPendingReady` true, so later
        // startPlugins calls chain onto the rejected promise and are skipped,
        // and the error surfaces as an unhandled rejection when no consumer
        // awaits `ready`.
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
