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


interface RootConfig<P> {
  props?: P;
}

interface SubRootConfig<P> extends RootConfig<P> {
  pluginManager?: PluginManager;
  onError?: (error: any, finalize: Function) => void;
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
  readonly prepared: boolean;
  readonly destroyed: boolean;
  prepare(): Promise<void>;
  mount(target: MountTarget, options?: MountOptions): Promise<InstanceType<T>>;
  destroy(): void;
}

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
        try {
          App.prototype.destroy.call(this);
        } catch {
        }
        throw error;
      }
    } else {
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
        return (preparedPromise = Promise.resolve());
      }
      if (error) {
        return Promise.reject(error);
      }
      fiber = new MountFiber(node, null);

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

      node.addHook("mounted", () => {
        resolve(node.component as InstanceType<T>);
        if (rejectMount) {
          const handlers = nodeErrorHandlers.get(node)!;
          handlers.splice(handlers.indexOf(rejectMount), 1);
        }
      });

      this.scheduler.addFiber(fiber);
      if (node.pluginManager.status < STATUS.MOUNTED) {
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
        return promise;
      }
      if (error) {
        return promise;
      }
      if (mounted) {
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
      await app.pluginManager.ready;
      if (app.destroyed) {
        throw makeAbortError();
      }
    }
    const root = app.createRoot(C, config);
    return await root.mount(target, config);
  } catch (error) {
    if (!app.destroyed) {
      try {
        app.destroy();
      } catch {
      }
    }
    throw error;
  }
}
