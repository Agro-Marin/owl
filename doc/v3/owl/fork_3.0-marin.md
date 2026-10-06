# The 3.0-marin fork

`3.0-marin` (Agro-Marin/owl) is `v3.0.0-alpha.49` plus the fork's commits
(`git log v3.0.0-alpha.49..3.0-marin`). Odoo vendors its build as
`web/static/lib/owl/owl.es.js`; `web/static/lib/versions.json` names the commit.
This page lists what the fork adds and where it deliberately behaves
differently from upstream.

## Added API

| API                                      | What it does                                                                                                                                                                                                                                                          | Reference                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `immediateEffect(fn)`                    | an effect that runs synchronously on each change, not in the next microtask                                                                                                                                                                                           | [effects](reference/effects.md)                                     |
| `observe(target, callback)`              | OWL 2's `reactive(target, callback)`: a view of `target` that calls `callback` once a value read through it changes                                                                                                                                                   | [proxies](reference/proxies.md#observe)                             |
| `computed(fn, { detached: true })`       | a computed that outlives the scope that created it                                                                                                                                                                                                                    | [computed values](reference/computed_values.md)                     |
| `selector(source)`                       | `isSelected(key)`, whose readers depend on the answer for their key only                                                                                                                                                                                              | [computed values](reference/computed_values.md#selectors)           |
| `t-memo="[deps]"`                        | on a keyed `t-foreach`: an item whose dependencies are unchanged keeps its previous content (child components included)                                                                                                                                               | [template syntax](reference/template_syntax.md#memoized-list-items) |
| `setDebug(channels)`, `setDebugSink(fn)` | opt-in debug logging per channel (reactivity, effect, computed, scope, plugin, scheduler, fiber, lifecycle, error, template, event)                                                                                                                                   | [debug logging](reference/debug_logging.md)                         |
| `@odoo/owl/runtime`                      | the runtime without the template compiler (`owl.runtime.es.js`, 34% smaller), for pages whose templates arrive precompiled                                                                                                                                            | —                                                                   |
| `@odoo/owl/compiler`                     | the compiler alone (`owl.compiler.es.js`, `owl.compiler.iife.js`); it imports nothing and registers itself, keyed by its build (version and hash), on `globalThis[Symbol.for("@odoo/owl/compiler")]`; a runtime takes its own build's, so two builds can share a page | [precompiling templates](reference/precompiling_templates.md)       |
| `batch(fn)`                              | groups writes: immediate effects run once, after the outermost batch (exported by `@odoo/owl` and `@odoo/owl/runtime`)                                                                                                                                                | [reactivity](reference/reactivity.md)                               |
| `markRaw(Class.prototype)`               | every instance of the class and of its subclasses stays raw: what a class with private members (`#x`) needs                                                                                                                                                           | [proxies](reference/proxies.md)                                     |

## Behaviour that differs from upstream

- **Template expressions read JavaScript's standard globals** (`String`,
  `Number`, `Boolean`, `JSON`, `parseInt`, `parseFloat`, `isNaN`, `Map`, `Set`,
  `Intl`, `Infinity`, the URI functions, …) as the globals, not from the
  context. Upstream reads them from the component and gets `undefined`.
- **`t-else` with a `t-if` on the same node** is an else branch holding the
  `if` — it reads as `t-elif`. Template inheritance produces it when an
  extension adds a `t-if` to an else node. `t-elif` beside another branch
  directive throws.
- **A translation context** (`t-translation-context-*`) beside `t-out` or
  `t-call-block` is not an unsupported directive.
- **Nested effects clean up inner first**: an effect's children are disposed
  before its own cleanup runs, on a re-run and on dispose.
- **A signal written and set back** before its readers run changed nothing
  for them (default equality only; a custom `equals` and `signal.trigger`
  always notify).
- **A cancelled render pass** does not make a child run `onWillUpdateProps`
  again for props it already holds.
- **Proxy reads nobody observes create no atom**; `in` / `has()` subscribe to
  the presence of the key they ask about only. The same holds for a `props()`
  view: a key read only untracked (in `setup`) gets no atom.
- **A `props({...})` view inherits from one frozen, empty object** whose own
  prototype is `null`, instead of having a `null` prototype itself: the views
  of a component class then share one hidden class, where upstream's are each
  a dictionary. It still inherits no key.
- **A props view is raw to `proxy()`**, both kinds: it is observable already, so
  a proxy of its component (a component held in proxied state) hands out the
  view itself, and its values unwrapped, instead of a proxy of it. Upstream's
  getters close over their signals and read through such a proxy; the fork's
  shared accessors find their view in a private field, which a proxy hides.
- **A `t-foreach` over a `proxy()` of a plain array reads its items in one
  step**, one subscription for the whole array. A subclass of `Array` (Odoo's
  mail `RecordList`, which answers its index reads through its own proxy) is
  iterated through its proxy, as upstream iterates every array.

### Reactivity

- **A computation read while it runs throws** `Cycle detected: <name> reads
its own value` instead of recursing (upstream hangs); a computed that catches
  it recovers once it stops reading itself. This includes a read by an
  observer its own write triggered: a computed whose getter writes state that
  an `immediateEffect` or `observe()` callback reads back through it throws,
  where upstream recomputed it re-entrantly.
- **Disposing an effect disposes the computeds it was the last observer of**,
  as destroying a component already did: read again, such a computed
  recomputes (a new object for an object result), and an effect its getter
  creates is created again, owned by its scope. `untrack` also stops an
  `observe()` view from subscribing to its reads.
- **An effect its own cleanup disposes does not run again**, and an effect
  keeps only a returned function as its cleanup.
- **A selector** notifies both keys of a change in one batch (a reader that
  throws no longer starves the other key), rethrows its source's error for
  every key and re-runs its readers on recovery, and follows its source only
  while a key is read.
- **`asyncComputed.currentPromise()`** also waits for a re-run a dependency
  change or `refresh()` queued; `dispose()` sets `loading()` to false.
- **`batched`** calls its callback with the latest call's arguments.

### Proxies, validation, plugins, registries

- **A getter or setter reaching a private member through a proxy** throws an
  OwlError naming the class to mark with `markRaw(<Class>.prototype)`, when a
  class of the proxied object declares that member (another class's private
  member error passes through unchanged). `markRaw` of a built-in prototype
  (`Object`, `Array`, `Map`, `Set`, `WeakMap`, `Function`) throws.
- **A write through a setter is one batch**: an immediate reader of the keys
  the setter writes runs once, after it returns.
- **A shallow proxy** (`signal.Array`, `signal.Object`) keeps a proxy written
  into it, as shallow Maps and Sets did.
- **`Object.defineProperty` through a proxy notifies like a write**, and
  `obj.hasOwnProperty(k)` subscribes to the presence of `k`. `Object.hasOwn`
  stays untracked (a descriptor trap slows every `Object.keys`).
- **A locked (non-configurable, non-writable) property** is handed out as it
  is by collections and `observe()` views too, as the Proxy invariant requires.
- **A collection's own properties** are read with the proxy as `this` (a
  subclass getter is tracked) and observed apart from its entries. Set
  operations reject a non-set-like argument as the native ones do.
- **`includes` / `indexOf` / `lastIndexOf`** on a proxied plain array
  subscribe to its items as one atom and search the raw array; a subclass of
  `Array` is searched through its proxy, as for `t-foreach`.
- **Through an `observe()` view**, `push` / `pop` / `shift` / `unshift` /
  `splice` do not subscribe the view, and `forEach` hands out views.
- **A constructor in a type schema** (`{ a: String }`) throws instead of
  accepting everything; a `customValidator` of an optional type is optional,
  with that type's default.
- **A plugin dependency cycle through `setup()`** throws "Circular plugin
  dependency"; a synchronous start failure leaves no later batch pending.
- **A forced `registry.use()`** restores the entry it overwrote when it ends.

### Components and rendering

- **A dynamic `t-component`** keys its child by an id of the class, not its
  name: two classes with the same name are two components.
- **`__owl__.children` lists committed children only**; a component a pending
  render creates appears once that render is committed.
- **A rejected `onWillStart` / `onWillUpdateProps`** of a render a newer one
  replaced, or of a destroyed component, is dropped (logged on `error`).
- **After a render pass fails** and its error is handled without a re-render,
  its other components keep rendering on their own; a component a failed
  commit already mounted gets `onMounted` (and only then `onWillUnmount`) from
  the next commit.
- **A Suspense's content belongs to its DOM**: it moves with the Suspense in
  a list, and works under a shadow root.
- **An error no handler catches under a Portal or Suspense** destroys the app
  once, like any other.
- **An `ErrorBoundary`** passes an error caught while its fallback shows to
  its parent; **`mount()`** destroys the App it created when the mount fails;
  **`render(true)`** renders every `t-memo` item again.

### Blockdom and events

- **A list removes its items one by one**, also as its parent's only child
  (no `textContent = ""` bulk clear): what a Portal or a widget put in that
  parent, before, after or between the items, survives.
- **A `value` property** (`t-att-value`, `t-model`) is set after the element's
  other attributes and its children: a select finds its `t-foreach` options,
  a range input its `max`. `disabled`, `readOnly`, `checked`, `selected` and
  `indeterminate` are written only when the element holds another value;
  `value` is written on every patch, as upstream.
- **Synthetic (`.synthetic`) handlers** also listen on the shadow root or other
  document an app is mounted in.
- **Every component `t-on` on a parent element shares one listener per kind**
  (event name, capture, passive, synthetic): a nested component's handler runs
  before the enclosing one's, whatever site or render made each, as the event
  bubbles; a native listener on that parent runs before or after all of them,
  not between. `t-on-*.self` on a component means the event targets one of its
  root elements.
- **`String()` of a `t-set` body** throws when the body holds a component
  (which it would create and never mount); a text node stringifies to its text,
  a bigint to its digits (`0n` included), a symbol to its description.
- **`t-tag` rejects prefixed and `block-` names**; a malformed block string and
  a `t-att` given a string or number throw an OwlError. A dynamic `t-call` key
  cannot collide across loop items, and symbols are valid `t-key`s.

### Templates

- **A directive that needs an expression throws on an empty one**, naming it;
  a `t-set-slot` nested directly in another throws.
- **`t-model.number`** checks the radio, or selects the static option, whose
  value equals the model's number.
- **Template expressions skip comments**; a statement keyword in an arrow's
  block body throws a named error; `delete` is an operator (`delete o.x`
  compiles; a context variable cannot be named `delete`); `{{ }}` and `#{ }`
  end at the brace that closes them; an arrow prop's free variables include
  those its parameter defaults read.
- **`__info__.hash`** is the commit, plus `-dirty-<digest>` when the sources
  differ from it (the version file the release script writes excluded);
  outside a git checkout, `nogit-<digest of the sources>`.

## Odoo integration contract

Odoo reaches into these internals; a refactor must keep their shape:
`node.renderFn` is an own function, wrapped and called unbound
(`web/core/utils/render_hooks.js`, HOOT, o_spreadsheet);
`app._compileTemplate(name, template)` is wrapped per instance
(`web/core/template_compile_cache.js`); `node.__owl__.children` is read as a
snapshot of the committed children; `App.version` + `__info__.hash` scope the template compile cache.

## Checks before re-vendoring into Odoo

1. `tools/odoo_migration/compile_templates.cjs`: every Odoo template file
   compiles with the new build.
2. `tools/odoo_migration/compile_inherited_templates.mjs`: every template
   compiles after Odoo's own template inheritance, with the new and the old
   build; it must print no `REGRESSION` line. `FREE_NAMES=1` also lists the
   component templates reading a context name nothing sets.
3. The `@web` HOOT suites (`WebSuite`, `MobileWebSuite`) and `@mail`'s
   (`MailSuite`, `MobileMailSuite`) with the old and the new build, compared
   test by test. Vendor the three files together (`owl.es.js`,
   `owl.runtime.es.js`, `owl.compiler.es.js`): a compiler from another build
   is refused. Odoo's `web/tests/test_esm_pipeline.py` checks the compiler
   module's shape (it imports nothing since the compiler registers itself).

## Test suites beyond upstream's

- `owl-core/tests/conformance.test.ts`: the cross-framework reactive
  conformance suite (`reactive-framework-test-suite`); 176 of 178 core cases,
  the two deliberate divergences marked as expected failures.
- `owl-compiler/tests/expression_fuzz.test.ts`: random expressions, compiled,
  against native evaluation.
- `owl-runtime/tests/compiler/template_fuzz.test.ts`: random templates,
  rendered and patched, against a reference renderer.
- `owl-runtime/tests/components/model_based.test.ts`: random render sequences
  (slow hooks resolved out of order, lists, `t-memo`, `selector`, a slot, an
  error boundary) settling on the render of the final state.
