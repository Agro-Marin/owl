import { version } from "./version";
import { ComponentConstructor } from "./component";
import { ComponentNode } from "./component_node";
import { GetProps } from "./props";
import {
  debug,
  debugLog,
  makeAbortError,
  OwlError,
  PluginConstructor,
  PluginManager,
  proxy,
  Resource,
  startPlugins,
  STATUS,
  toRaw,
} from "@odoo/owl-core";
import { nodeErrorHandlers } from "./rendering/error_handling";
import {
  Fiber,
  hostedSubRoots,
  MountFiber,
  MountOptions,
  RootFiber,
  subRootHosts,
} from "./rendering/fibers";
import { Scheduler } from "./rendering/scheduler";
import { TemplateSet, TemplateSetConfig } from "./template_set";
import { validateTarget } from "./utils";

// reimplement dev mode stuff see last change in 0f7a8289a6fb8387c3c1af41c6664b2a8448758f

interface RootConfig<P> {
  props?: P;
}

// Internal-only options threaded into createRoot by createSubRoot.
interface SubRootConfig<P> extends RootConfig<P> {
  // overrides the root node's plugin manager so ancestor `providePlugins`
  // contributions are visible in the subtree. Defaults to app.pluginManager.
  pluginManager?: PluginManager;
  // error handler seeded on the root node so descendant errors route back into
  // the host's parent chain instead of tearing down the whole app.
  onError?: (error: any, finalize: Function) => void;
  // the component node hosting the sub-root, so the scheduler can delay
  // renders inside the sub-root while an ancestor of the host is rendering.
  host?: ComponentNode;
}

export interface AppConfig extends TemplateSetConfig {
  name?: string;
  plugins?: PluginConstructor[] | Resource<PluginConstructor>;
  config?: object;
  test?: boolean;
}

let hasBeenLogged = false;

const apps = new Set<App>();

declare global {
  interface Window {
    __OWL_DEVTOOLS__: {
      apps: Set<App>;
      Fiber: typeof Fiber;
      RootFiber: typeof RootFiber;
      toRaw: typeof toRaw;
      proxy: typeof proxy;
    };
  }
}

import type { MountTarget } from "./blockdom";

interface Root<T extends ComponentConstructor> {
  promise: Promise<InstanceType<T>>;
  // true once the render phase has finished. Read synchronously right after
  // prepare() to detect a fully-synchronous subtree (Suspense's no-flash fast
  // path). false while the render is still pending or not yet started.
  readonly prepared: boolean;
  // true once destroy() has been called. A destroyed root is inert: prepare()
  // and mount() become no-ops, so a teardown racing with an in-flight
  // prepare-then-mount sequence needs no guard at the call site.
  readonly destroyed: boolean;
  // Kick off rendering without a DOM target. Descendants' onWillStart fires
  // immediately and the bdom is built in memory. Idempotent — second call
  // returns the same promise. Resolves when the render phase finishes, or as
  // soon as the root is destroyed (the render phase will then never complete).
  prepare(): Promise<void>;
  // Mount the (possibly already-prepared) bdom into target, then fire
  // onMounted hooks. If prepare() was not called, mount() prepares first.
  // On a destroyed root this does nothing and the returned promise stays
  // pending: the mount was cancelled, not completed.
  mount(target: MountTarget, options?: MountOptions): Promise<InstanceType<T>>;
  destroy(): void;
}

// what the owl devtools read, set by the first App (importing owl changes no
// global): their page hook watches the property, so it finds the apps whether
// it loads before or after it is set; a page's first owl keeps it
function exposeToDevtools() {
  if (typeof window !== "undefined" && !window.__OWL_DEVTOOLS__) {
    window.__OWL_DEVTOOLS__ = { apps, Fiber, RootFiber, toRaw, proxy };
    if (debug.lifecycle) {
      debugLog("lifecycle", "window.__OWL_DEVTOOLS__ set");
    }
  }
}

export class App extends TemplateSet {
  static validateTarget = validateTarget;
  static apps = apps;
  static version = version;

  name: string;
  scheduler = new Scheduler();
  roots: Set<Root<any>> = new Set();
  pluginManager: PluginManager<this>;
  destroyed = false;

  constructor(config: AppConfig = {}) {
    const isTest = config.test;
    super(isTest ? { ...config, dev: true } : config);
    this.name = config.name || "";
    // Read configuration before registration: an accessor throwing gives
    // its caller no app to remove from the registry.
    const plugins = config.plugins;
    const pluginConfig = config.config;
    if (!apps.size) {
      exposeToDevtools();
    }
    apps.add(this);
    this.pluginManager = new PluginManager(this, { config: pluginConfig });
    if (plugins) {
      try {
        startPlugins(this.pluginManager, plugins);
      } catch (error) {
        // The caller gets no app when construction fails. Earlier plugins
        // may already own effects/listeners, and the devtools registry holds
        // the app: release all of it while preserving the startup error.
        try {
          // Derived fields have not been initialized yet. Construction
          // failure must not dispatch to a subclass's destroy override.
          App.prototype.destroy.call(this);
        } catch {
          // Report the startup error rather than an error from its cleanup.
        }
        throw error;
      }
    } else {
      // No plugins provided: nothing to await, mark as MOUNTED so mount()
      // takes the sync fast path.
      this.pluginManager.status = STATUS.MOUNTED;
    }
    if (this.dev && !isTest && !hasBeenLogged) {
      console.info(`Owl is running in 'dev' mode.`);
      hasBeenLogged = true;
    }
  }

  createRoot<T extends ComponentConstructor>(
    Root: T,
    config: RootConfig<GetProps<InstanceType<T>>> = {}
  ): Root<T> {
    if (this.destroyed) {
      throw new OwlError("Cannot create a root in a destroyed app");
    }
    if (debug.lifecycle) {
      debugLog("lifecycle", `create root ${Root.name}${this.name ? ` in app ${this.name}` : ""}`);
    }
    const props = config.props || {};
    const { promise, resolve, reject } = Promise.withResolvers<InstanceType<T>>();
    let node: ComponentNode;
    let error: any = null;
    // Sub-roots (Portal/Suspense) thread their host's scope and error routing
    // in through internal config, applied before the render phase begins.
    const subConfig = config as SubRootConfig<GetProps<InstanceType<T>>>;
    try {
      node = new ComponentNode(Root, props, this, null, null, subConfig.pluginManager);
      if (subConfig.onError) {
        nodeErrorHandlers.getOrInsertComputed(node, () => []).unshift(subConfig.onError);
      }
      if (subConfig.host) {
        subRootHosts.set(node, subConfig.host);
        hostedSubRoots.getOrInsertComputed(subConfig.host, () => new Set()).add(node);
      }
    } catch (e) {
      error = e;
      reject(e);
    }

    let fiber: MountFiber | null = null;
    let preparedPromise: Promise<void> | null = null;
    let resolvePrepared: (() => void) | null = null;
    let destroyed = false;
    let mounted = false;

    const prepare = (): Promise<void> => {
      if (preparedPromise) {
        return preparedPromise;
      }
      if (destroyed) {
        // Destroyed before the render phase started: no fiber, and no
        // onWillStart on an already finalized component.
        return (preparedPromise = Promise.resolve());
      }
      if (error) {
        return Promise.reject(error);
      }
      fiber = new MountFiber(node, null);

      // Until it is mounted, an error no handler of the root catches rejects
      // the mount (and destroys the app). Not for a sub-root: nobody waits
      // for its mount, its errors go to its host's chain.
      let rejectMount: ((error: any, finalize: Function) => void) | null = null;
      if (!subConfig.onError) {
        rejectMount = (error, finalize) => {
          finalize();
          reject(error);
        };
        nodeErrorHandlers.getOrInsertComputed(node, () => []).unshift(rejectMount);
      }

      const ready = new Promise<void>((res) => {
        resolvePrepared = res;
        fiber!.onPrepared = () => res();
      });
      preparedPromise = ready;

      // Install the mount-resolve callback up front so the sync render path's
      // `if (node.mounted.length)` check sees it and registers the fiber in
      // root.mounted. Without this ordering the callback would never fire for
      // the commit-after-prepare sequence.
      node.addHook("mounted", () => {
        resolve(node.component as InstanceType<T>);
        if (rejectMount) {
          const handlers = nodeErrorHandlers.get(node)!;
          handlers.splice(handlers.indexOf(rejectMount), 1);
        }
      });

      this.scheduler.addFiber(fiber);
      if (node.pluginManager.status < STATUS.MOUNTED) {
        // Plugins have pending onWillStart callbacks — await them before the
        // root renders, so plugin state is populated during first render.
        node.willStart.unshift(() => node.pluginManager.ready);
      }
      try {
        node.start(fiber);
      } catch (e) {
        reject(e);
      }
      return preparedPromise;
    };

    const mount = (target: MountTarget, options?: MountOptions): Promise<InstanceType<T>> => {
      if (destroyed) {
        // Inert: no target validation, no dom insertion. Committing here would
        // insert a finalized subtree into the document and flip it back to
        // MOUNTED, with nothing left to ever clean it up.
        return promise;
      }
      if (error) {
        return promise;
      }
      if (mounted) {
        // a second commit would retarget a pending mount, or do nothing once
        // the first one completed
        throw new OwlError("This root is already mounted: create another root to mount again");
      }
      App.validateTarget(target);
      prepare();
      mounted = true;
      fiber!.commit(target, options);
      return promise;
    };

    const root = {
      get prepared() {
        // counter === 0 means every descendant has rendered — the synchronous
        // signal that the render phase is done. (MountFiber.prepared is only
        // set later, when the scheduler runs complete() in the next frame.)
        return fiber ? fiber.counter === 0 : false;
      },
      get destroyed() {
        return destroyed;
      },
      promise,
      prepare,
      mount,
      destroy: () => {
        if (destroyed) {
          return;
        }
        destroyed = true;
        this.roots.delete(root);
        if (subConfig.host && node) {
          hostedSubRoots.get(subConfig.host)?.delete(node);
        }
        try {
          node?.destroy();
        } finally {
          // The scheduler drops destroyed fibers, so onPrepared cannot
          // release awaiters, even when destruction itself throws.
          resolvePrepared?.();
        }
      },
    };
    this.roots.add(root);
    return root;
  }

  destroy() {
    if (debug.lifecycle) {
      debugLog(
        "lifecycle",
        `destroy app${this.name ? ` ${this.name}` : ""}, ${this.roots.size} root(s)`
      );
    }
    let failure: { error: unknown } | null = null;
    for (let root of this.roots) {
      try {
        root.destroy();
      } catch (error) {
        failure ||= { error };
      }
    }
    try {
      this.pluginManager.destroy();
    } catch (error) {
      failure ||= { error };
    }
    this.scheduler.tasks.clear();
    Scheduler.active.delete(this.scheduler);
    this.scheduler.delayedRenders = [];
    apps.delete(this);
    this.destroyed = true;
    if (failure) {
      throw failure.error;
    }
  }

  _handleError(error: any) {
    throw error;
  }
}

export function createSubRoot<T extends ComponentConstructor>(
  app: App,
  Root: T,
  config: SubRootConfig<GetProps<InstanceType<T>>>
): Root<T> {
  return app.createRoot(Root, config);
}

export async function mount<T extends ComponentConstructor>(
  C: T,
  target: MountTarget,
  config: AppConfig & RootConfig<GetProps<InstanceType<T>>> & MountOptions = {}
): Promise<InstanceType<T>> {
  const app = new App(config);
  try {
    if (app.pluginManager.status < STATUS.MOUNTED) {
      // Plugins are still starting: wait for them before building the root, so
      // the root's setup/field initializers can safely call plugin() — including
      // plugins that only start in a later sequence batch.
      await app.pluginManager.ready;
      if (app.destroyed) {
        throw makeAbortError();
      }
    }
    const root = app.createRoot(C, config);
    return await root.mount(target, config);
  } catch (error) {
    // the caller has no handle on this app: a failed mount must not leave it
    // registered, nor its root alive
    if (!app.destroyed) {
      try {
        app.destroy();
      } catch {
        // the mount's own error is the one reported
      }
    }
    throw error;
  }
}
