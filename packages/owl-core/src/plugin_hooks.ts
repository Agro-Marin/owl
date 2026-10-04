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
  // a component asking for a plugin a nearer provider has yet to start must
  // not get one further up: its children would get the nearer one. Starting
  // it now would run its setup before the data of the earlier batch it may
  // read is loaded.
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

  // A plugin can define a specialized, per-consumer view of itself (see
  // PluginConstructor.scoped); the view is bound to the calling scope. It is
  // the view of the plugin actually found, which may shadow the requested one
  // under the same id.
  const scoped = (plugin.constructor as PluginConstructor).scoped;
  return (scoped ? scoped(plugin, scope) : plugin) as PluginInstance<T>;
}

/** @deprecated alias for {@link usePlugin} */
export const plugin = usePlugin;

export function useConfig<T = any>(key: string): T;
export function useConfig<T>(key: string, type: WithDefault<T>): T;
export function useConfig<T>(key: string, type: Optional<T>): T | undefined;
export function useConfig<T>(key: string, type: T): StripBrands<T>;
export function useConfig(key: string, type?: any): any {
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

/** @deprecated alias for {@link useConfig} */
export const config = useConfig;
