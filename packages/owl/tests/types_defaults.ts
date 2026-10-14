import { config, props, Registry, Resource, t, type GetProps, type StripBrands } from "../src";

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
declare function assertEq<A, B>(...args: Eq<A, B> extends true ? [] : [never]): void;

class Comp {
  props = props({
    p: t.number().optional(4),
    q: t.string().optional("a"),
    r: t.string(),
    s: t.boolean().optional(),
  });
}
declare const comp: Comp;
void comp;

assertEq<typeof comp.props.p, number>();
assertEq<typeof comp.props.q, string>();
assertEq<typeof comp.props.r, string>();
assertEq<typeof comp.props.s, boolean | undefined>();

type ParentProps = GetProps<Comp>;
const ok1: ParentProps = { r: "x" };
const ok2: ParentProps = { r: "x", p: 1, q: "y", s: true };
const ko1: ParentProps = { p: 1 };
const ko2: ParentProps = { r: "x", p: "nope" };
const ko3: ParentProps = { r: "x", s: 1 };

class OnlyOptionals {
  props = props({
    className: t.string().optional(),
    close: t.function().optional(),
  });
}
declare const onlyOptionals: OnlyOptionals;
void onlyOptionals;
assertEq<typeof onlyOptionals.props.className, string | undefined>();
type OptParentProps = GetProps<OnlyOptionals>;
const ok3: OptParentProps = {};
const ok4: OptParentProps = { className: "a" };
const ko4: OptParentProps = { className: 4 };

props({ p: t.number().optional(4) });
props({ p: t.number().optional(() => 4) });
props({ p: t.number().optional("4") });
props({ cb: t.function().optional(() => () => {}) });
props({ cb: t.function().optional(() => {}) });

function _staticPropCheck() {
  const label = props.static("label", t.string().optional("fallback"));
  assertEq<typeof label, string>();
  const plain = props.static("plain", t.string());
  assertEq<typeof plain, string>();
  const opt = props.static("opt", t.string().optional());
  assertEq<typeof opt, string | undefined>();
  void [label, plain, opt];
}

function _configCheck() {
  const delay = config("delay", t.number().optional(500));
  assertEq<typeof delay, number>();
  const plain = config("plain", t.number());
  assertEq<typeof plain, number>();
  const opt = config("opt", t.number().optional());
  assertEq<typeof opt, number | undefined>();
  void [delay, plain, opt];
}

function _registryCheck() {
  const registry = new Registry({ validation: t.string() });
  registry.add("key", "some value");
  const value = registry.get("key");
  assertEq<typeof value, string>();
  assertEq<ReturnType<typeof registry.items>, string[]>();
  registry.add("other", 42);

  const resource = new Resource({ validation: t.number() });
  resource.add(5);
  assertEq<ReturnType<typeof resource.items>, number[]>();
  resource.add("nope");
  void value;
}

const NotificationShape = {
  message: t.string(),
  className: t.string().optional("card"),
  sticky: t.boolean().optional(),
};
class FromObjectSchema {
  props = props(t.object(NotificationShape).toShape());
}
declare const fromObjectSchema: FromObjectSchema;
assertEq<typeof fromObjectSchema.props.message, string>();
assertEq<typeof fromObjectSchema.props.className, string>();
assertEq<typeof fromObjectSchema.props.sticky, boolean | undefined>();

const ComposedSchema = t.and([
  t.object({ message: t.string() }),
  t.object({ autocloseDelay: t.number().optional(4000), sticky: t.boolean().optional() }),
]);
class FromComposedSchema {
  props = props(ComposedSchema.toShape());
}
declare const fromComposedSchema: FromComposedSchema;
assertEq<typeof fromComposedSchema.props.message, string>();
assertEq<typeof fromComposedSchema.props.autocloseDelay, number>();
assertEq<typeof fromComposedSchema.props.sticky, boolean | undefined>();

void [ok1, ok2, ok3, ok4, ko1, ko2, ko3, ko4, _staticPropCheck, _configCheck, _registryCheck];
void [fromObjectSchema, fromComposedSchema];

const WithOptional = t.and([t.object({ a: t.number() }).optional(), t.object({ b: t.string() })]);
assertEq<StripBrands<typeof WithOptional>, { a: number } & { b: string }>();

const Unchecked = t.object<{ a: ReturnType<typeof t.number> }>();
assertEq<ReturnType<typeof Unchecked.toShape>, {}>();
void WithOptional;

const Empty = t.and([]);
assertEq<StripBrands<typeof Empty>, unknown>();
void Empty;
void Unchecked;
