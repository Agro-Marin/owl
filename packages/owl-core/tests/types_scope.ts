import { PluginManager, Scope, type ScopeApp } from "../src";

class MinimalScope extends Scope {}

// A host need not have a manager yet: PluginManager constructs itself during
// app bootstrap. App's dev flag is optional for hosts using core on its own.
const host: ScopeApp = {};
const manager = new PluginManager(host);
host.pluginManager = manager;
const scope = new MinimalScope(host);
const sameManager: PluginManager | undefined = scope.app.pluginManager;
void sameManager;
new PluginManager({ dev: false, pluginManager: manager });

// Extra host methods remain inferred without importing a concrete runtime App
// into core or forcing callers to cast the manager's host back to its type.
const customHost = { dev: true, destroy: () => 1 };
const customManager = new PluginManager(customHost);
const result: number = customManager.app.destroy();
void result;
// @ts-expect-error plugin managers keep their host reference
customManager.app = { dev: false, destroy: () => 2 };
const coreManager: PluginManager = customManager;
// @ts-expect-error widening the manager must not allow discarding host methods
coreManager.app = {};

// @ts-expect-error development mode is a boolean, not an unvalidated config value
new PluginManager({ dev: "true" });
// @ts-expect-error the app's manager must implement the actual core manager contract
new MinimalScope({ pluginManager: {} });
// @ts-expect-error core must not reach an undeclared runtime method through app
scope.app.getTemplate("some template");
