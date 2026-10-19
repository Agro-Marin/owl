import { debug, debugLog } from "./debug";
import { OwlError } from "./owl_error";
import { Plugin, PluginConstructor, PluginManager } from "./plugin_manager";
import { useScope } from "./scope";
import { getDefault, types, type Optional, type Schema, type WithDefault } from "./types";
import { assertType } from "./validation";

export type PluginInstance<T extends PluginConstructor> = Omit<InstanceType<T>, "setup">;

export function usePlugin<T extends PluginConstructor>(pluginType: T): PluginInstance<T> {
  const scope = useScope();

  const manager = scope.pluginManager;
  const isPlugin = scope instanceof PluginManager;
  const id = pluginType.id;
  const pendingIn = manager.pendingIn(id);
  if (pendingIn && (!isPlugin || pendingIn !== manager)) {
    if (debug.plugin && isPlugin) {
      debugLog("plugin", `${id} is pending in a parent manager, not started here`);
    }
    throw new OwlError(
      `Plugin "${id}" is not started yet: its batch waits for the onWillStart of a lower sequence. Use it from a child component, or lower its sequence.`
    );
  }
  let plugin: Plugin | null = manager.getPlugin(pluginType);
  if (!plugin && !isPlugin && manager.getPluginById(id)) {
    throw new OwlError(
      `Plugin "${id}" is another class with the same id; declare a distinct static id on one of them`
    );
  }
  plugin ??= isPlugin ? manager.startPlugin(pluginType) : null;
  if (!plugin) {
    throw new OwlError(`Unknown plugin "${id}"`);
  }
  if (isPlugin && debug.plugin && manager.isStarting(plugin.constructor)) {
    debugLog("plugin", `${id} handed out before its setup ends`);
  }

  const scoped = (plugin.constructor as PluginConstructor).scoped;
  return (scoped ? scoped(plugin, scope) : plugin) as PluginInstance<T>;
}

export const plugin = usePlugin;

export function useConfig<T = unknown>(key: string): NoInfer<T>;
export function useConfig<T>(key: string, type: WithDefault<T>): T;
export function useConfig<T>(key: string, type: Optional<T>): T | undefined;
export function useConfig<T>(key: string, type: Schema<T>): T;
export function useConfig(key: string, type?: unknown): unknown {
  const scope = useScope();
  if (!(scope instanceof PluginManager)) {
    throw new OwlError("Expected to be in a plugin scope");
  }
  const configValue = readConfig(scope.config, key);
  if (scope.app.dev && type) {
    assertType(
      { [key]: configValue },
      types.object({ [key]: type }),
      "Config does not match the type"
    );
  }
  return configValue === undefined ? getDefault(type)?.() : configValue;
}

function readConfig(config: object, key: string): unknown {
  for (
    let level = config;
    level && level !== Object.prototype;
    level = Object.getPrototypeOf(level)
  ) {
    if (Object.hasOwn(level, key)) {
      return Reflect.get(level, key, config);
    }
  }
  return undefined;
}

export const config = useConfig;
