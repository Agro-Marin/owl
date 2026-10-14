import { debug, debugLog } from "./debug";
import { OwlError } from "./owl_error";
import { PluginConstructor, PluginManager } from "./plugin_manager";
import { useScope } from "./scope";
import { getDefault, types, type Optional, type StripBrands, type WithDefault } from "./types";
import { assertType } from "./validation";

export type PluginInstance<T extends PluginConstructor> = Omit<InstanceType<T>, "setup">;

export function usePlugin<T extends PluginConstructor>(pluginType: T): PluginInstance<T> {
  const scope = useScope();

  const manager = scope.pluginManager;
  const isPlugin = scope instanceof PluginManager;
  if (!isPlugin && manager.isPending(pluginType.id)) {
    throw new OwlError(
      `Plugin "${pluginType.id}" is not started yet: its batch waits for the onWillStart of a lower sequence. Use it from a child component, or lower its sequence.`
    );
  }
  const plugin =
    manager.getPluginById(pluginType.id) ?? (isPlugin ? manager.startPlugin(pluginType) : null);
  if (!plugin) {
    throw new OwlError(`Unknown plugin "${pluginType.id}"`);
  }
  if (isPlugin && debug.plugin && manager.isStarting(plugin.constructor)) {
    debugLog("plugin", `${pluginType.id} handed out before its setup ends`);
  }

  const scoped = (plugin.constructor as PluginConstructor).scoped;
  return (scoped ? scoped(plugin, scope) : plugin) as PluginInstance<T>;
}

export const plugin = usePlugin;

export function useConfig<T = unknown>(key: string): NoInfer<T>;
export function useConfig<T>(key: string, type: WithDefault<T>): T;
export function useConfig<T>(key: string, type: Optional<T>): T | undefined;
export function useConfig<T>(key: string, type: T): StripBrands<T>;
export function useConfig(key: string, type?: unknown): unknown {
  const scope = useScope();
  if (!(scope instanceof PluginManager)) {
    throw new OwlError("Expected to be in a plugin scope");
  }
  if (scope.app.dev && type) {
    assertType(scope.config, types.object({ [key]: type }), "Config does not match the type");
  }
  const configValue = scope.config[key];
  return configValue === undefined ? getDefault(type)?.() : configValue;
}

export const config = useConfig;
