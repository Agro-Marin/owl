import { PluginManager, useApp, useConfig, config, t, type ScopeApp } from "../src";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
declare function assertEq<A, B>(...args: Eq<A, B> extends true ? [] : [never]): void;

const app = useApp();
assertEq<IsAny<typeof app>, false>();
assertEq<typeof app, ScopeApp>();
app.createRoot(class {});
app.dev = "true";

interface CustomHost extends ScopeApp {
  lookup(id: string): number;
}
const customApp = useApp<CustomHost>();
assertEq<ReturnType<typeof customApp.lookup>, number>();
useApp<{ dev: string }>();
const contextualApp: CustomHost = useApp();
const customAppReader: () => CustomHost = useApp;
declare function acceptCustomHost(host: CustomHost): void;
acceptCustomHost(useApp());
const explicitAppReader: () => CustomHost = useApp<CustomHost>;

const value = useConfig("value");
assertEq<IsAny<typeof value>, false>();
assertEq<typeof value, unknown>();
value.toFixed();
const aliasValue = config("value");
assertEq<IsAny<typeof aliasValue>, false>();
aliasValue.toFixed();
const contextualValue: number = useConfig("value");
const contextualAliasValue: number = config("value");
declare function acceptNumber(value: number): void;
acceptNumber(useConfig("value"));
const inferredReader = (): number => {
  return useConfig("value");
};

assertEq<ReturnType<typeof useConfig<number>>, number>();
const typed = useConfig<number>("value");
assertEq<typeof typed, number>();
const explicitConfigReader: (key: string) => number = useConfig<number>;
acceptNumber(useConfig<number>("value"));
const required = useConfig("value", t.number());
assertEq<typeof required, number>();
const optional = useConfig("value", t.number().optional());
assertEq<typeof optional, number | undefined>();
const defaulted = useConfig("value", t.number().optional(1));
assertEq<typeof defaulted, number>();
const explicitOptional = useConfig<number>("value", t.number().optional());
assertEq<typeof explicitOptional, number | undefined>();
const explicitDefaulted = useConfig<number>("value", t.number().optional(1));
assertEq<typeof explicitDefaulted, number>();
const defaultedCallback = useConfig(
  "callback",
  t.function([], t.string()).optional(() => () => "")
);
assertEq<typeof defaultedCallback, () => string>();
const nested = useConfig("nested", t.object({ label: t.string(), count: t.number().optional(1) }));
assertEq<typeof nested, { label: string; count?: number }>();
acceptNumber(useConfig("value", t.number()));
acceptNumber(useConfig("value", t.number().optional(1)));
acceptNumber(useConfig("value", t.number().optional()));
acceptNumber(useConfig("value", t.string()));

interface NamedConfig {
  count: number;
  callback: () => string;
}
declare const namedConfig: NamedConfig;
const manager = new PluginManager({}, { config: namedConfig });
const storedValue = manager.config.value;
assertEq<IsAny<typeof storedValue>, false>();
assertEq<typeof storedValue, unknown>();
storedValue.toFixed();
manager.config.extra = new Date();
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
  explicitOptional,
  explicitDefaulted,
  defaultedCallback,
  nested,
  contextualApp,
  customAppReader,
  explicitAppReader,
  contextualValue,
  contextualAliasValue,
  inferredReader,
  explicitConfigReader,
];
