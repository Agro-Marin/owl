# The 3.0-marin fork

`3.0-marin` (Agro-Marin/owl) is `v3.0.0-alpha.49` plus the fork's commits
(`git log v3.0.0-alpha.49..3.0-marin`). Odoo vendors its build as
`web/static/lib/owl/owl.es.js`; `web/static/lib/versions.json` names the commit.
This page lists what the fork adds and where it deliberately behaves
differently from upstream.

## Added API

| API                                      | What it does                                                                                                                                                                                                                                  | Reference                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `immediateEffect(fn)`                    | an effect that runs synchronously on each change, not in the next microtask                                                                                                                                                                   | [effects](reference/effects.md)                                     |
| `observe(target, callback)`              | OWL 2's `reactive(target, callback)`: a view of `target` that calls `callback` once a value read through it changes                                                                                                                           | [proxies](reference/proxies.md#observe)                             |
| `computed(fn, { detached: true })`       | a computed that outlives the scope that created it                                                                                                                                                                                            | [computed values](reference/computed_values.md)                     |
| `selector(source)`                       | `isSelected(key)`, whose readers depend on the answer for their key only                                                                                                                                                                      | [computed values](reference/computed_values.md#selectors)           |
| `t-memo="[deps]"`                        | on a keyed `t-foreach`: an item whose dependencies are unchanged keeps its previous content (child components included)                                                                                                                       | [template syntax](reference/template_syntax.md#memoized-list-items) |
| `setDebug(channels)`, `setDebugSink(fn)` | opt-in debug logging per channel (reactivity, effect, computed, scope, plugin, scheduler, fiber, lifecycle, error, template, event)                                                                                                           | [debug logging](reference/debug_logging.md)                         |
| `@odoo/owl/runtime`                      | the runtime without the template compiler (`owl.runtime.es.js`, 34% smaller), for pages whose templates arrive precompiled                                                                                                                    | —                                                                   |
| `@odoo/owl/compiler`                     | the compiler alone (`owl.compiler.es.js`); it imports nothing and registers itself, keyed by its build (version and hash), on `globalThis[Symbol.for("@odoo/owl/compiler")]`; a runtime takes its own build's, so two builds can share a page | [precompiling templates](reference/precompiling_templates.md)       |
| `batch(fn)`                              | groups writes: immediate effects run once, after the outermost batch (exported by `@odoo/owl` and `@odoo/owl/runtime`)                                                                                                                        | [reactivity](reference/reactivity.md)                               |
| `markRaw(Class.prototype)`               | every instance of the class and of its subclasses stays raw: what a class with private members (`#x`) needs                                                                                                                                   | [proxies](reference/proxies.md)                                     |

## Packaging and targets

- **A true ES module package**: every entry is one ES module (no CommonJS
  twin; Node's `require()` loads the same instance as `import`). Importing a
  build changes no global and registers nothing, so a bundle keeps only what
  it uses (`import { signal }` bundles to 5.9 KB gz of the runtime's 35);
  `"sideEffects"` names the compiler module alone (whose registration is its
  purpose). No IIFE script and no global `owl` either: the devtools
  extension's own pages import the ES build like any other code. `window.__OWL_DEVTOOLS__` is set by the first
  `App`; owl's own components make their template on first read (as
  `__owl__<Name>`); `requestAnimationFrame` is still captured when the module
  is evaluated, before a test framework can mock it (HOOT relies on that).
- **Targets the latest only**: the dist is built for chrome154, firefox157,
  safari27 and node26 (`packages/owl/build_target.mjs`, Odoo's
  `_ESBUILD_TARGET` plus the server's Node), with no down-levelling; the
  sources may use any API all four have (today `Promise.withResolvers` and
  `WeakMap.getOrInsertComputed`), and `tests/dist.test.ts` keeps the dist off
  any a target lacks. The toolchain requires Node >=26 (`.node-version`),
  runs the compiler's TypeScript sources directly for the standalone
  precompiler, and the internal workspace packages are private.
- In the full build, `TemplateSet.compiler = undefined` restores its bundled
  compiler.

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
  creates is created again, owned by the computed. `untrack` also stops an
  `observe()` view from subscribing to its reads.
- **An effect belongs to the computation whose run creates it**, tracked or
  not (`untrack` keeps the owner): an effect's, a computed's (detached ones
  included), a selector source's or an `observe()` callback's effect is
  disposed before that run is repeated and when the computation is disposed;
  a render's lasts until its component is destroyed. A scope being set up is
  an ownership root. Upstream gives a getter's effect to the computed's scope
  (or to nothing), and `untrack` drops ownership. `effect(fn, { detached:
true })` creates an effect owned by nothing. When a computed and an effect
  it owns are both due, the computed runs first. An `asyncComputed` is
  disposed whole by its owner (no longer loading, the abandoned run's result
  ignored).
- **A computed whose getter writes a source it read ends out of date**: its
  next read checks its sources and recomputes if one changed since the getter
  read it (upstream kept the value computed from the old source). An effect
  that writes the source of a computed it read keeps the computed's value it
  read, as it keeps a signal's: it runs when a later write changes the
  computed from that value, not when the value comes back; the computed
  forwards that write to its readers instead of being recomputed when the run
  ends. Owl passes the cross-framework conformance suite with no expected
  failure.
- **A cleanup that throws while computeds are disposed** does not stop the
  others: on a recompute it is reported as an unhandled rejection, on a
  cascade the dispose throws after releasing everything, and in bulk the
  error goes to the flush or to `reportError`.
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
- **A write through a setter, an array write (an index or the length) and a
  delete are each one batch**: an immediate reader of several keys the write
  notifies runs once, after it. An index written past the end of an array
  behind its own Proxy notifies its length, also through a shallow proxy.
- **A Map proxy, and an `observe()` view of a Map, have no `add`** (it reads
  `undefined`, as on a Map). A set operation (`union`, `intersection`, …) on a
  proxy checks its argument as the native method does and returns a plain Set
  of the members as its own set holds them, the target's first.
- **A shallow proxy** (`signal.Array`, `signal.Object`) keeps a proxy written
  into it, as shallow Maps and Sets did.
- **`obj.hasOwnProperty(k)` through a proxy subscribes to the presence of
  `k`**, as `in` does. `Object.defineProperty` stays untracked, as upstream
  (Odoo's web_studio defines a label getter on a proxied field inside a
  computed). `Object.hasOwn`, `propertyIsEnumerable` and
  `Object.getOwnPropertyDescriptor` stay untracked too: tracking them takes a
  `getOwnPropertyDescriptor` trap, which also runs for every write through the
  proxy (the write asks its receiver, the proxy, for the key's descriptor) and
  for every key `Object.keys`, a spread or `JSON.stringify` lists. Measured on
  Node 26, a forwarding trap alone: a write 244 -> 355 ns, `Object.keys` of 100
  keys 16 -> 24 µs; in Odoo, 11 000 to 14 000 trap calls per list or kanban
  navigation over 49 records. Ask with `in` or `obj.hasOwnProperty(k)`.
- **A locked (non-configurable, non-writable) property** is handed out as it
  is by collections and `observe()` views too, as the Proxy invariant requires.
- **A collection's own properties** are read with the proxy as `this` (a
  subclass getter is tracked) and observed apart from its entries. Set
  operations reject a non-set-like argument as the native ones do.
- **`includes` / `indexOf` / `lastIndexOf`** on a proxied plain array
  subscribe to its items as one atom and search the raw array; a subclass of
  `Array` is searched through its proxy, as for `t-foreach`.
- **Through an `observe()` view**, `forEach` hands out views; a `push` or
  `splice` reads the length through the view and calls its callback, as OWL 2's
  `reactive([], callback)` did.
- **A constructor in a type schema** (`{ a: String }`) throws instead of
  accepting everything; a `customValidator` of an optional type is optional,
  with that type's default.
- **A plugin dependency cycle through constructors or field initializers**
  throws "Circular plugin dependency" instead of overflowing the stack; plugins
  asking for each other in `setup()` each get the other (logged on the `plugin`
  channel). A synchronous start failure leaves no later batch pending.
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
  **`render(true)`** renders every `t-memo` item again, and the content of a
  Portal or Suspense too (a separate root, once the host's render is done).

### Blockdom and events

- **A bound property** (`t-att-value`, `t-attf-value`, `t-att-checked`,
  `disabled`, `readOnly`, `selected`, `indeterminate`) is given to its block as
  its value and its setter runs on every patch (a value is always written, a
  flag only when the element differs); upstream wraps each in a new
  `String`/`Boolean` per render. `t-model`'s property is set only when the
  model changes.
- **A block string has one block type**, given its handlers at each call
  (`type(data, children, handlers)`, the list checked by
  `createBlock(str, list)`; a missing list throws at mount), so making an
  App's template functions makes no block type per handler site.
- **A handler's code is static**: `createCatcher(spec, [fns])`; a render gives a handler only its context (a
  `t-model`'s model in a slot linked by `block-handler-arg-N`), the element
  reads code, context and model from its block when the event fires, and
  modifiers come from the key. `config.mainEventHandler` is
  `(fn, mods, ctx, ev, currentTarget, arg?)`. A render allocates no handler
  array.
- **A child's key is exact**: the site id, each loop key and `t-key`, slot and
  template names are segments (`\u0002`, a tag, a payload; a payload's
  `\u0002` doubled), so no value of any type or content spells another
  child's key. A loop key carries its type (`1` and `"1"` are two keys; an
  array is compared by its items), and a slot's default content has its own
  segment. Upstream concatenates strings, and a collision leaves a component
  no deep render or destroy reaches.
- **A `t-set` body output by another component renders in that component**:
  its components are that component's children, its expressions still read
  the context they were written in (upstream creates them in the component
  that set the body, whose fiber may be gone, and crashes).
- **A `t-on` on a component or slot mounted by its component's own render**
  looks up the handler enclosing it at its first dispatch, not mid-patch
  (logged on `event`).
- **A list empties its parent at once only when its items, one node each,
  and its anchor are all the parent holds** (checked node by node, again
  after the unmount hooks); otherwise it removes them one by one. What a
  Portal or a widget put before, after or among the items survives either
  way. A text, html or multi anchor removal does nothing once its node is
  detached.
- **A `value` property** (`t-att-value`, `t-model`) is set after the element's
  other attributes and its children: a select finds its `t-foreach` options,
  a range input its `max`. `disabled`, `readOnly`, `checked`, `selected` and
  `indeterminate` are written only when the element holds another value;
  `value` is written on every patch, as upstream.
- **Synthetic (`.synthetic`) handlers** also listen on the shadow root or other
  document an app is mounted in; each root replays only the nodes of its own
  tree, with the target a native listener there would see (capture handlers
  inside a shadow root, closed ones included, run for composed events). The
  handlers of one event and phase, passive or not, are replayed in one pass,
  in path order, up to a stop; a passive one cannot prevent the default.
- **Every component `t-on` on a parent element shares one listener per kind**
  (event name, capture, passive, synthetic): a nested component's handler runs
  before the enclosing one's, whatever site or render made each, as the event
  bubbles; a native listener on that parent runs before or after all of them,
  not between. `t-on-*.self` on a component means the event targets one of its
  root elements.
- **A `t-set` body given to an attribute, interpolation, property or `t-att`
  is its string taken during the render** (`attrValue` / `attrsValue`), so the
  attribute follows what the body reads.
- **`String()` of a `t-set` body** throws when the body holds a component
  (which it would create and never mount); a text node stringifies to its text,
  a bigint to its digits (`0n` included), a symbol to its description.
- **`t-tag` rejects prefixed and `block-` names**; a malformed block string and
  a `t-att` given a string or number throw an OwlError. A dynamic `t-call` key
  cannot collide across loop items, and symbols are valid `t-key`s.

### Templates

- **What is read later sees the values at its place**: an event handler, a
  slot's content, a called template's context and a `t-set` body read the
  variables as they were where the template gives them, as OWL 2 did
  (upstream OWL 3 read them when the event fires, or when the child renders
  its slot on its own: a later `t-set`, or a later loop item writing a
  variable of an enclosing scope, showed through). The compiler copies the
  context there only when a later `t-set` of the same template can write a
  variable that code reads (a called template's reads are not known: any);
  else it is kept as it is. In Odoo's 3494 templates, 131 places in 51
  templates are copied. A `t-set` body reads its variables at its `t-set`
  (upstream: at its output), as QWeb in Python does.
- **Scoping as QWeb's**, documented as it works: a `t-if` or an element opens
  no scope; a loop item does, and writes a variable `t-set` earlier outside
  it in the same template.
- **A `t-out` showing one `t-set` body, then another** (the variable set again
  in a branch) replaces the content: upstream patched one body's blocks with
  the other's, which crashed when one was a list, and else kept showing the
  first.
- **A directive that needs an expression throws on an empty one**, naming it;
  a `t-set-slot` nested directly in another throws.
- **`t-model.number`** checks the radio, or selects the static option, whose
  value equals the model's number.
- **Template expressions skip comments**; a statement keyword in an arrow's
  block body throws a named error; `delete` is an operator (`delete o.x`
  compiles; a context variable cannot be named `delete`); `{{ }}` and `#{ }`
  end at the brace that closes them; an arrow prop's free variables include
  those its parameter defaults read.
- **Slots are not marked raw per render**: `callSlot` renders a descriptor
  read through a proxy from its raw object (logged on `template`); slots put in
  proxied state come back proxied, like any prop.
- **An item of a loop in a loop, and a t-call context (with attributes or a
  body) in a loop, are made under the outer item's prototype with a copy of
  its loop names**, when no `t-set` writes that loop level and no expression
  of the template assigns a context variable: the outer item does not become a
  prototype (V8 deoptimizes a fresh object made one). Only a context variable
  assigned at event time by a bare-called template could tell the difference.
- **A slot without a slot scope and a t-call with neither attributes nor body
  render in the context they are given**, not a child of it (only a bare-name
  `t-model.proxy` can tell): a new context under one made in this render costs
  V8 about 1.6 µs and 1.2 KB. A render makes no function for its slots, slot
  defaults, t-call bodies and t-out bodies. `t-props` copies with object
  spread (an own `__proto__` key is a prop). A t-call attribute is assigned on
  the new context, so one named like a getter-only property up the context
  chain is ignored (Owl's own contexts hold none).
- **`__info__.hash`** is the commit, plus `-dirty-<digest>` when the sources
  differ from it (the version file the release script writes excluded);
  outside a git checkout, `nogit-<digest of the sources>`.

Several debug texts are shorter than in earlier fork builds, and `debug` is
built from `DEBUG_CHANNELS`.

## Odoo integration contract

Odoo reaches into these internals; a refactor must keep their shape:
Block strings, block types (called with their handler list as third
argument), handler data and `mainEventHandler` are internal; Odoo reads
none of them. A slot descriptor is `{__render, __ctx, __owner, __scope?, ...attrs}`
(`__render` static, run with `__owner`), and a t-call body sits in the call
context under the `zero` / `zeroCtx` helper symbols; Odoo reads none of them.
`node.renderFn` is an own function, wrapped and called unbound
(`web/core/utils/render_hooks.js`, HOOT, o_spreadsheet);
`app._compileTemplate(name, template)` is wrapped per instance
(`web/core/template_compile_cache.js`); `node.__owl__.children` is read as a
snapshot of the committed children; `App.version` + `__info__.hash` scope the template compile cache.

## Checks before re-vendoring into Odoo

1. `tools/odoo_migration/compile_templates.mjs <roots>`: every Odoo template
   file compiles with the new build.
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

- `owl-runtime/tests/compiler/template_fuzz.test.ts` also mounts random
  templates as components (slots, `t-call`, `t-on` with `.stop`/`.prevent`/
  `.self`/`.capture`, `t-model` in both forms with `.lazy`/`.trim`/`.number`,
  bound properties), dispatches every event on every element after each
  render, and checks which handlers ran, where, and `defaultPrevented` against
  a propagation model, plus form state after simulated edits and deep renders
  (`OWL_TEMPLATE_FUZZ_SEED` picks the seed). It fails within four templates
  on the handler-order bug d6c1a1da fixed, which owl's other suites missed
  (that bug did not need a child block: a handler on a nested element
  followed by a sibling's sufficed). `model_based.test.ts` checks click
  dispatch, a stale loop context included. Its reference renderer scopes
  variables as the compiler does (a `t-if` or an element opens no scope, a
  loop item does and writes a variable `t-set` earlier outside it), and every
  third `t-set` it generates sets again a variable in scope: against upstream's
  live contexts it fails within six templates, and it found a body output at
  one site patched with another body's blocks.

- `owl-core/tests/foreign_proxy.ts`: targets behind a foreign Proxy (Odoo
  mail's record and `RecordList` shapes, forwarding Proxies); the owl-core and
  owl-runtime `foreign_proxy.test.ts` files run the reactive contract and
  `t-foreach` against each.
- `owl-core/tests/conformance.test.ts`: the cross-framework reactive
  conformance suite (`reactive-framework-test-suite`): every case passes, with
  no expected failure.
- `owl-compiler/tests/expression_fuzz.test.ts`: random expressions, compiled,
  against native evaluation.
- `owl-runtime/tests/compiler/template_fuzz.test.ts`: random templates,
  rendered and patched, against a reference renderer.
- `owl-runtime/tests/components/model_based.test.ts`: random render sequences
  (slow hooks resolved out of order, lists, `t-memo`, `selector`, a slot, an
  error boundary) settling on the render of the final state.
