import { PluginManager, Scope, type ScopeApp } from "../src";

class MinimalScope extends Scope {}

const host: ScopeApp = {};
const manager = new PluginManager(host);
host.pluginManager = manager;
const scope = new MinimalScope(host);
const sameManager: PluginManager | undefined = scope.app.pluginManager;
void sameManager;
new PluginManager({ dev: false, pluginManager: manager });

const customHost = { dev: true, destroy: () => 1 };
const customManager = new PluginManager(customHost);
const result: number = customManager.app.destroy();
void result;
customManager.app = { dev: false, destroy: () => 2 };
const coreManager: PluginManager = customManager;
coreManager.app = {};

new PluginManager({ dev: "true" });
new MinimalScope({ pluginManager: {} });
scope.app.getTemplate("some template");
