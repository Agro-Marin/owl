// Compile-time checks for hook signatures. This file is only typechecked
// (npm run test:types); it is not executed.
import { App, signal, useApp, useConfig, config, useOnChange, providePlugins } from "../src";

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
declare function assertEq<A, B>(...args: Eq<A, B> extends true ? [] : [never]): void;

declare const count: ReturnType<typeof signal<number>>;
declare const label: ReturnType<typeof signal<string>>;

// each dependency keeps its own type, without needing `as const`
useOnChange(
  () => [count(), label()],
  (c, l) => {
    assertEq<typeof c, number>();
    assertEq<typeof l, string>();
  }
);

// the callback may declare fewer parameters than there are dependencies...
useOnChange(
  () => [count(), label()],
  (c) => {
    assertEq<typeof c, number>();
  }
);

// ... or none at all
useOnChange(
  () => [count()],
  () => {}
);

// the callback may return a cleanup function
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
  // @ts-expect-error the callback cannot declare more parameters than there are
  // dependencies
  (_c: number, _extra: string) => {}
);

useOnChange(
  () => [count()],
  // @ts-expect-error wrong dependency type
  (_c: string) => {}
);

useOnChange(
  // @ts-expect-error dependencies must return an array
  () => count(),
  () => {}
);

useOnChange(
  () => [count()],
  () => {},
  // @ts-expect-error unknown option
  { initial: false }
);

const app = useApp();
assertEq<typeof app, App>();
// @ts-expect-error runtime App has no arbitrary dynamic methods
app.missingMethod();

class CustomApp extends App {
  lookup(id: string): number {
    return id.length;
  }
}
const customApp = useApp<CustomApp>();
assertEq<typeof customApp, CustomApp>();
// @ts-expect-error the runtime hook requires a complete App contract
useApp<{ dev: boolean }>();
// @ts-expect-error a contextual assignment cannot implicitly narrow App
const contextualApp: CustomApp = useApp();
// @ts-expect-error a function signature cannot implicitly narrow App
const customAppReader: () => CustomApp = useApp;
declare function acceptCustomApp(app: CustomApp): void;
// @ts-expect-error an argument context cannot implicitly narrow App
acceptCustomApp(useApp());
const explicitAppReader: () => CustomApp = useApp<CustomApp>;

const unchecked = useConfig("unchecked");
// @ts-expect-error configuration without a schema or explicit type is unknown
unchecked.toFixed();
const aliasUnchecked = config("unchecked");
// @ts-expect-error the deprecated alias must not erase the unknown return type
aliasUnchecked.toFixed();
// @ts-expect-error contextual assignment cannot type unchecked configuration
const contextualConfig: number = useConfig("unchecked");
// @ts-expect-error an alias cannot infer config types from assignments
const contextualAliasConfig: number = config("unchecked");

interface NamedConfig {
  timeout: number;
  lookup: (id: string) => number;
}
const namedConfig: NamedConfig = { timeout: 1, lookup: (id) => id.length };
new App({ config: namedConfig });
providePlugins([], namedConfig);
// @ts-expect-error app configuration must be an object
new App({ config: 1 });
// @ts-expect-error provider configuration must be an object
providePlugins([], "config");

void [
  customApp,
  contextualApp,
  customAppReader,
  explicitAppReader,
  contextualConfig,
  contextualAliasConfig,
];
