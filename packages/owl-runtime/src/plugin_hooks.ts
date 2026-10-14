import {
  onWillDestroy,
  onWillStart,
  PluginConstructor,
  PluginManager,
  Resource,
  startPlugins,
  STATUS,
} from "@odoo/owl-core";
import { getComponentScope } from "./component_node";

export { useConfig, config, usePlugin, plugin, type PluginInstance } from "@odoo/owl-core";

export function providePlugins(
  pluginConstructors: PluginConstructor[] | Resource<PluginConstructor>,
  config?: object
) {
  const node = getComponentScope();

  const manager = new PluginManager(node.app, { parent: node.pluginManager, config });
  node.pluginManager = manager;
  onWillDestroy(() => manager.destroy());

  startPlugins(manager, pluginConstructors);

  if (manager.status < STATUS.MOUNTED) {
    onWillStart(() => manager.ready);
  }
}
