import { App, signal, useApp, useConfig, config, useOnChange, providePlugins } from "../src";

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
declare function assertEq<A, B>(...args: Eq<A, B> extends true ? [] : [never]): void;

declare const count: ReturnType<typeof signal<number>>;
declare const label: ReturnType<typeof signal<string>>;

useOnChange(
  () => [count(), label()],
  (c, l) => {
    assertEq<typeof c, number>();
    assertEq<typeof l, string>();
  }
);

useOnChange(
  () => [count(), label()],
  (c) => {
    assertEq<typeof c, number>();
  }
);

useOnChange(
  () => [count()],
  () => {}
);

useOnChange(
  () => [count()],
  (c) => () => {
    assertEq<typeof c, number>();
  }
);

useOnChange(
  () => [count()],
  () => {},
  { initialRun: false }
);

useOnChange(
  () => [count()],
  (_c: number, _extra: string) => {}
);

useOnChange(
  () => [count()],
  (_c: string) => {}
);

useOnChange(
  () => count(),
  () => {}
);

useOnChange(
  () => [count()],
  () => {},
  { initial: false }
);

const app = useApp();
assertEq<typeof app, App>();
app.missingMethod();

class CustomApp extends App {
  lookup(id: string): number {
    return id.length;
  }
}
const customApp = useApp<CustomApp>();
assertEq<typeof customApp, CustomApp>();
useApp<{ dev: boolean }>();
const contextualApp: CustomApp = useApp();
const customAppReader: () => CustomApp = useApp;
declare function acceptCustomApp(app: CustomApp): void;
acceptCustomApp(useApp());
const explicitAppReader: () => CustomApp = useApp<CustomApp>;

const unchecked = useConfig("unchecked");
unchecked.toFixed();
const aliasUnchecked = config("unchecked");
aliasUnchecked.toFixed();
const contextualConfig: number = useConfig("unchecked");
const contextualAliasConfig: number = config("unchecked");

interface NamedConfig {
  timeout: number;
  lookup: (id: string) => number;
}
const namedConfig: NamedConfig = { timeout: 1, lookup: (id) => id.length };
new App({ config: namedConfig });
providePlugins([], namedConfig);
new App({ config: 1 });
providePlugins([], "config");

void [
  customApp,
  contextualApp,
  customAppReader,
  explicitAppReader,
  contextualConfig,
  contextualAliasConfig,
];
