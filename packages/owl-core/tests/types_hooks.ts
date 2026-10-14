import { PluginManager, useApp, useConfig, config, t, type ScopeApp } from "../src";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
declare function assertEq<A, B>(...args: Eq<A, B> extends true ? [] : [never]): void;

const app = useApp();
assertEq<IsAny<typeof app>, false>();
assertEq<typeof app, ScopeApp>();
// @ts-expect-error core hosts do not guarantee runtime App methods
app.createRoot(class {});
// @ts-expect-error the host's development flag is boolean
app.dev = "true";

interface CustomHost extends ScopeApp {
  lookup(id: string): number;
}
const customApp = useApp<CustomHost>();
assertEq<ReturnType<typeof customApp.lookup>, number>();
// @ts-expect-error a custom host must satisfy ScopeApp
useApp<{ dev: string }>();

const value = useConfig("value");
assertEq<IsAny<typeof value>, false>();
assertEq<typeof value, unknown>();
// @ts-expect-error unchecked configuration must be narrowed before use
value.toFixed();
const aliasValue = config("value");
assertEq<IsAny<typeof aliasValue>, false>();
// @ts-expect-error the deprecated alias has the same unchecked return type
aliasValue.toFixed();

assertEq<ReturnType<typeof useConfig<number>>, number>();
const typed = useConfig<number>("value");
assertEq<typeof typed, number>();
const required = useConfig("value", t.number());
assertEq<typeof required, number>();
const optional = useConfig("value", t.number().optional());
assertEq<typeof optional, number | undefined>();
const defaulted = useConfig("value", t.number().optional(1));
assertEq<typeof defaulted, number>();
const defaultedCallback = useConfig(
  "callback",
  t.function([], t.string()).optional(() => () => "")
);
assertEq<typeof defaultedCallback, () => string>();
const nested = useConfig("nested", t.object({ label: t.string(), count: t.number().optional(1) }));
assertEq<typeof nested, { label: string; count?: number }>();

interface NamedConfig {
  count: number;
  callback: () => string;
}
declare const namedConfig: NamedConfig;
const manager = new PluginManager({}, { config: namedConfig });
const storedValue = manager.config.value;
assertEq<IsAny<typeof storedValue>, false>();
assertEq<typeof storedValue, unknown>();
// @ts-expect-error the manager cannot assume the type of a dynamic config key
storedValue.toFixed();
manager.config.extra = new Date();
// @ts-expect-error configuration is an object
new PluginManager({}, { config: 1 });

void [
  app,
  customApp,
  value,
  aliasValue,
  typed,
  required,
  optional,
  defaulted,
  defaultedCallback,
  nested,
];
