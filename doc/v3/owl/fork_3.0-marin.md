# The 3.0-marin fork

`3.0-marin` (Agro-Marin/owl) is `v3.0.0-alpha.49` plus the fork's commits
(`git log 4bd42fe7..3.0-marin`: `4bd42fe7` is upstream's `[REL] v3.0.0-alpha.49`;
the fork's releases are tagged `v3.0.0-marin.N` by `npm run release`, below). Odoo vendors its builds in
`web/static/lib/owl/`: the browser imports `@odoo/owl` as `owl.runtime.es.js` and
`@odoo/owl/compiler` as `owl.compiler.es.js`, and the server's template
precompiler runs the full `owl.es.js`; `web/static/lib/versions.json` names the commit.
This page lists what the fork adds and where it deliberately behaves
differently from upstream; [the behaviour specification](specification.md)
states the contract (reactivity, proxies, validation, plugins, registries,
rendering, events and templates), each rule naming its test.

The fork also adapts selected changes through upstream `d2c0fa9e`:
`useImmediateEffect`, awaitable `asyncComputed.refresh()`, collection schemas,
ordered portals and devtools name copying. Its compatibility hooks, `t-slot`,
`status()` and `Plugin.__owl__` remain supported. A failed effect's first run
is disposed even when it has an owner; a self-writing `useOnChange` keeps the
dependency values its callback read, without an eager reread after the callback.
These remain deliberate differences from current upstream.

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
  it uses (`import { signal }` bundles to 7.6 kB gz of the runtime's 41.2, minified
  and gzipped; `tests/dist.test.ts` holds each entry to a size budget);
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
  any a target lacks. The toolchain requires Node >=26 (`.node-version`; every test suite
  refuses an older one by name),
  runs the compiler's TypeScript sources directly for the standalone
  precompiler, and the internal workspace packages are private.
- `build.mjs [types] --outdir <dir>` builds into another directory than
  `dist/`, replacing its `owl.*.js` files and leaving any other; the package
  tests and the benchmarks build into their own directory under `temp/` and
  never touch `dist/` or `/tmp`, and `build:devtools` builds the package first and
  compiles the devtools templates into `dist/devtools/`, not the source tree.
- The standalone precompiler rejects partial output and duplicate names,
  preserves an existing artifact on compilation errors, and writes the output
  only once it compiled whole, into the existing file (which keeps its
  permissions and hard links; a write that fails half way, such as on a full
  disk, leaves it truncated). `NODE_DEBUG=owl-compile` traces the operation.
- In the full build, `TemplateSet.compiler = undefined` restores its bundled
  compiler.

## Behaviour that differs from upstream

What the fork changed relative to upstream `v3.0.0-alpha.49`, one line per
difference. Each behaviour is stated, rule by rule and with the test that
asserts it, in [the specification](specification.md); what the specification
does not hold is kept under [Not in the specification](#not-in-the-specification).

### Reactivity

See [specification: Reactivity](specification.md#reactivity).

- A computation read while it runs throws `Cycle detected` (upstream hangs).
- Bringing a computed up to date is a batch: an immediate effect or
  `observe()` callback it queues no longer runs inside the evaluation, nor
  throws `Cycle detected` (upstream recomputed the computed re-entrantly).
- Disposing an effect disposes the computeds it was the last observer of, and
  a computed a re-run stops reading is disposed at the flush (upstream: at the
  next write to its sources, which a computed reading nothing never got).
- An effect belongs to the computation whose run creates it, through `untrack`
  too (upstream gave a getter's effect to the computed's scope or to nothing,
  and `untrack` dropped ownership); `effect(fn, { detached: true })` is new.
- A computed whose getter writes its source ends out of date (upstream kept the
  value computed from the old source); a write during a run or a check is
  forwarded instead of held back for good.
- The cross-framework conformance suite passes with no expected failure.
- A cleanup that throws while computeds are disposed no longer stops the other
  disposals.
- An effect disposed by its own cleanup or run stays disposed (an immediate one
  was run again re-entrantly, and the write threw `Cycle detected`); only a
  returned function is kept as cleanup.
- A selector notifies both keys in one batch (a throwing reader starved the
  other key), rethrows its source's error for every key, and follows its source
  only while a key is read.
- `asyncComputed`: `currentPromise()` also waits for a queued run, `dispose()`
  clears `loading()`, and a synchronous fetcher throw keeps its abort cleanup.
- Scope destruction and rollback run cleanup unsubscribed and unowned; rollback
  drains the callbacks its cleanup registers.
- A write schedules the effects' flush only when it queues something no
  scheduled flush will run (af18b4f5 scheduled one at every write).
- `batched` calls its callback with the latest call's arguments.

### Proxies, validation, plugins, registries

See [specification: Proxies](specification.md#proxies),
[Validation](specification.md#validation),
[Plugins](specification.md#plugins) and
[Registries](specification.md#registries).

- A getter or setter reaching a private member through a proxy throws an
  OwlError naming `markRaw(<Class>.prototype)`; `markRaw` of a built-in
  prototype throws.
- A write through a setter, an array write and a delete are each one batch; a
  setter's getter is called only when the key is observed; an index written
  past the end of an array behind its own Proxy notifies its length.
- A Map proxy has no `add`; set operations (`union`, `intersection`, …) check
  and read their argument as the native ones do, compare members raw and return
  a plain Set.
- Collection mutations are one batch, and `set` and `add` return the reactive
  collection; `getOrInsert` and `getOrInsertComputed` are reactive.
- A shallow proxy keeps a proxy written into it; a collection that already
  holds a proxy finds it and notifies through it (members and keys stay raw, as
  upstream).
- `obj.hasOwnProperty(k)` through a proxy subscribes to the presence of `k`;
  `Object.defineProperty`, `Object.hasOwn`, `propertyIsEnumerable` and
  `Object.getOwnPropertyDescriptor` stay untracked, as upstream.
- A locked property is handed out as it is by collections and `observe()`
  views too.
- A collection's own properties are read with the proxy as `this`, apart from
  its entries.
- `includes` / `indexOf` / `lastIndexOf` on a proxied plain array subscribe to
  one atom and search the raw array.
- An `observe()` view keeps a read made between a change and its callback
  (upstream dropped it with the subscriptions the callback ends); `forEach`,
  `push`, `splice` and collection iterators go through the view, as OWL 2's
  `reactive([], callback)` did.
- A constructor in a type schema throws (upstream accepted everything), at the
  top level too; an optional type's `customValidator` is optional; `t.ref()`
  is declared without a DOM; `applyDefaults` copies plain data only.
- A schema is typed as a schema (upstream's `Type<T> = T & {…}` let
  `t.number().toFixed()` compile), and so are `Registry` / `Resource`
  `validation`, `useConfig`, `registry.get(key, d)` and `useListener`; a
  component's `this.constructor` is typed as its class (upstream: `Function`).
- A plugin dependency cycle throws "Circular plugin dependency" (upstream
  overflowed the stack); plugins asking for each other in `setup()` each get
  the other; a synchronous start failure leaves no later batch pending.
- A plugin without a declared `static id` is found only for its own class (two
  classes named `Theme` were one plugin), while a declared id still shadows by
  id, as upstream; a dependency started with its dependent's id throws the
  duplicate-id error instead of being overwritten.
- Plugin starts: nested starts hold their batch, a child manager no longer
  starts a copy of its parent's pending plugin, a plugin deferred behind a
  pending start is pending too, a rejected start no longer blocks later ones,
  an empty list leaves the manager ready, a resource-driven start belongs to
  its manager, and `startPlugin` runs in its manager's scope.
- Plugins are torn down before the plugins they use; `useConfig` ignores
  `Object.prototype` members; an App whose constructor fails while starting
  plugins cleans up after itself.
- A forced `registry.use()` restores the entry it overwrote when it ends.

### Components and rendering

See [specification: Rendering](specification.md#rendering).

- A dynamic `t-component` keys its child by an id of the class, not its name.
- `__owl__.children` lists committed children only.
- A rejected `onWillStart` / `onWillUpdateProps` of a superseded render or a
  removed component is dropped.
- After a failed render pass, the other components keep rendering on their
  own, and a commit is never committed again.
- A first mount that throws half way rolls back, then the recovery mounts
  afresh instead of patching a half-mounted tree.
- An `onWillUnmount` that throws during a patch no longer aborts it.
- A synchronous throw in `onWillUpdateProps` is handled as a rejection is.
- A Suspense's content moves with its DOM and works under a shadow root; an
  error no handler catches under a Portal or Suspense destroys the app once.
- An `ErrorBoundary` passes an error of its fallback to its parent; `mount()`
  destroys the App it created when the mount fails, and rejects with an
  `AbortError` when that App is destroyed first; `render(true)` reaches
  `t-memo` items and the content of a Portal or Suspense.

### Blockdom and events

See [specification: Events and blockdom](specification.md#events-and-blockdom).

- A bound property is given to its block as its value (upstream wraps each in
  a new `String`/`Boolean` per render); `value` is set after the element's
  other attributes and children.
- A `class`, `style` or `t-att` object is applied at every patch against a
  copy of what its slot last wrote (upstream skips a value identical to the
  previous one and diffs against that value, mutated too); Owl never repairs
  changes made by other code.
- A proxied class or style object is read during the render (upstream read it
  only at the patch, untracked, so a change in place showed only once something
  else re-rendered).
- A block string has one block type, given its handlers at each call; a
  handler's code is static; a mounted block's `toString()` is its element's
  markup (upstream mounted the block again, losing it).
- A child's key is exact (upstream concatenates strings, and a collision leaves
  a component no deep render or destroy reaches); a list item is diffed by that
  key, and a `t-key` keys every component under it (before, such content was
  remounted while its components kept their key, and the render crashed).
- A `t-set` body output by another component renders in that component
  (upstream creates its components in the component that set the body, whose
  fiber may be gone, and crashes); given to an attribute it is its string at
  render; `String()` of it throws when it holds a component.
- A `t-on` on a component or slot mounted by its component's own render finds
  its enclosing handler at its first dispatch, not mid-patch.
- The component `t-on`s on a parent element share one listener per kind and
  run as nested elements would (upstream walked the catchers inside out in both
  phases and never stopped).
- Synthetic handlers also listen on shadow roots and other documents, each
  root replaying its own nodes in one pass; a component's synthetic handlers
  form a level inside its parent element's (before, they ran in the order their
  kinds were first used in the page, and never stopped each other).
- A list empties its parent at once only when its items and anchor are all the
  parent holds.
- An explicit `xmlns` inside a namespaced block is its element's namespace
  (upstream kept the enclosing one); a prefixed attribute, static or dynamic,
  keeps its namespace.
- A ref is set once its element is in the document, outermost first (upstream
  ran a nested block's before its parent element was inserted); removing a
  block releases the refs inside it (upstream released only the removed
  block's own); an element removed by other code keeps its ref until owl
  removes it (upstream cleared it at the component's next patch).
- `.passive` with `.prevent` throws when the template compiles.
- `t-tag` rejects prefixed and `block-` names; a malformed block string, and a
  `t-att` given a string or a number, throw; a dynamic `t-call` key cannot
  collide across loop items; symbols are valid `t-key`s.

### Templates

See [specification: Templates](specification.md#templates).

- What is read later (handlers, slots, `t-set` bodies, arrow props, …) sees the
  variables at its place, as OWL 2 did (upstream OWL 3 read them when the event
  fires, or when the child renders its slot on its own); a `t-set` body reads
  them at its `t-set` (upstream: at its output), as QWeb in Python does.
- A directive on a `t-set-slot` node makes only its content conditional, and
  scoping is QWeb's: both as upstream, now documented.
- A `t-out` showing one `t-set` body, then another, replaces the content
  (upstream patched one body's blocks with the other's, crashing on a list).
- A `t-call-block`'s block or a slot output of another kind replaces the
  previous one (upstream patched one into the other).
- A directive Owl would drop throws (upstream ignored `t-raw`, a typo such as
  `t-esle`, `t-att-class` on a `<t>`, a `t-set-slot` outside a component).
- A `t-set` with a `t-value` and a blank body takes the value (upstream took
  the whitespace); a CDATA section is text (upstream dropped it).
- A directive needing an expression throws on an empty one, `t-tag` included
  (upstream ignored it); a `t-set-slot` nested directly in another throws.
- `t-out="0"` with blanks around the `0` outputs the call's body (upstream: the
  number); `t-model.trim` on a checkbox throws (it compiled
  `ev.target.checked.trim()`); `t-model.number` matches radios and static
  options.
- A template that does not compile names the expression, its attribute,
  element and template (upstream: "could not tokenize", or the bare JavaScript
  error and the generated code); `this` is refused as a template variable.
- Template expressions skip comments, reject statements, object literal
  methods and function expressions by name, and parse `1 .toString()`,
  `delete`, interpolation ends and divisions correctly.
- A prop with two suffixes throws `Invalid prop suffix` (upstream applied one
  of them).
- Slots are not marked raw per render.
- Nested loop items, and t-call contexts in loops, are made under the outer
  item's prototype; a slot without a slot scope and a bare t-call render in the
  context they are given.
- `__info__.hash` and `__info__.date` name the build's sources and date.

### Not in the specification

What the specification does not state: behaviour no test there asserts, the
reasons behind a design, and Odoo's stakes.

**Template expressions and names.**

- Template expressions read JavaScript's standard globals (`String`, `Number`,
  `Boolean`, `JSON`, `parseInt`, `parseFloat`, `isNaN`, `Map`, `Set`, `Intl`,
  `Infinity`, `Promise`, `Reflect`, `WeakMap`, `globalThis`, the error types,
  the typed arrays, the URI functions, …) as the globals, not from the
  context: every global of a fresh JavaScript context that all four targets
  have (a test holds the list to Node's), so not `SharedArrayBuffer` (a
  browser global only in a cross-origin-isolated page), `Temporal`,
  `DisposableStack`, `AsyncDisposableStack` or `SuppressedError` (not in
  Safari).
  Upstream reads them from the component and gets `undefined`.
- A `t-set`, `t-as`, `t-slot-scope` or `t-call` argument named like a global
  or a keyword (`null`), not an identifier (`a-b`, `data-label`, an empty
  name), or an operator word (`and`, `or`, `gt`, `gte`, `lt`, `lte`, `typeof`,
  `delete`) throws; a `t-call` argument's suffix (`label.translate`) is not
  part of its name.
- `t-else` with a `t-if` on the same node is an else branch holding the `if`,
  as `t-elif` reads (template inheritance produces it when an extension adds a
  `t-if` to an else node); `t-elif` beside another branch directive throws.
- A translation context (`t-translation-context-*`) beside `t-out` or
  `t-call-block` is not an unsupported directive.
- `String()` of a `t-set` body gives a symbol as `String()` gives it
  (`Symbol(s)`).
- The standalone precompiler: a prefixed attribute is given its namespace in
  the block string so the template compiles under JSDOM too, while a prefixed
  element name (`<s:Envelope>`) still does not compile there.
- Values at their place hold for a `t-props` value, a `t-call` argument, a
  slot argument and a called template's context too; two suffixes throw for a
  t-call or slot argument too; an element, like a `t-if`, opens no scope.
- `owl-compiler/tests/compile_errors.test.ts` holds one template per compile
  error.

**Reactivity, proxies and props.**

- Nested effects clean up inner first: an effect's children are disposed
  before its own cleanup runs, on a re-run and on dispose.
- A signal written and set back before its readers run changed nothing for
  them (default equality only; a custom `equals` and `signal.trigger` always
  notify); an effect that writes a signal and reads it again runs when the
  value it read first comes back.
- Proxy reads nobody observes create no atom, and `in` / `has()` subscribe to
  the presence of the key they ask about only; a `props()` view's key read
  only untracked (in `setup`) gets no atom. A key's atom is released when its
  last reader unsubscribes, so a target nobody reads any more is written as one
  never read, and `clear()` notifies only the keys something reads, walking
  those keys instead of the collection when they are fewer and all primitive.
- A `props({...})` view inherits from one frozen, empty object whose own
  prototype is `null`: the views of a component class share one hidden class,
  where upstream's are each a dictionary. It still inherits no key.
- A props view is raw to `proxy()`, both kinds: a proxy of its component hands
  out the view itself and its values unwrapped. Upstream's getters close over
  their signals and read through such a proxy; the fork's shared accessors
  find their view in a private field, which a proxy hides.
- A `t-foreach` over a `proxy()` of a plain array reads its items in one step,
  one subscription for the whole array; a subclass of `Array` (Odoo's mail
  `RecordList`, which answers its index reads through its own proxy) is
  iterated, and searched, through its proxy.
- `Object.hasOwn`, `propertyIsEnumerable` and `Object.getOwnPropertyDescriptor`
  stay untracked because tracking them takes a `getOwnPropertyDescriptor` trap,
  which also runs for every write through the proxy and for every key
  `Object.keys`, a spread or `JSON.stringify` lists. Measured on Node 26, a
  forwarding trap alone: a write 244 -> 355 ns, `Object.keys` of 100 keys
  16 -> 24 µs; in Odoo, 11 000 to 14 000 trap calls per list or kanban
  navigation over 49 records. Ask with `in` or `obj.hasOwnProperty(k)`.
- `Object.defineProperty` stays untracked because Odoo's web_studio defines a
  label getter on a proxied field inside a computed.
- An `observe()` view subscribes in any context because Odoo's
  `useRecordObserver` first reads its view in `onWillStart`, which runs
  untracked.
- `props.static` takes a `Schema<V>`, and a constructor given to it as a type
  throws, as for `validateType`.

**Rendering.**

- A cancelled render pass does not make a child run `onWillUpdateProps` again
  for props it already holds.
- A failed commit's component gets no `onWillPatch` either while it is owed
  `onMounted`.
- `render(true)` renders a Portal's or Suspense's content as a separate root,
  once the host's render is done.

**Blockdom internals.**

- A handler's code is static: `createCatcher(spec, [fns])`; a render gives a
  handler only its context (a `t-model`'s model in a slot linked by
  `block-handler-arg-N`), the element reads code, context and model from its
  block when the event fires, and modifiers come from the key.
  `config.mainEventHandler` is `(fn, mods, ctx, ev, currentTarget, arg?)`.
- A child key's segments are `\u0002`, a tag and a payload, a payload's
  `\u0002` doubled.
- The classes of an element without a static one are written in one
  `setAttribute` on mount; a plain class or style object is not walked again
  during the render, as a proxied one is (`objectAttrValue`); a `t-set` body
  given to an attribute is taken by `attrValue` / `attrsValue`.
- A list checks that it is alone in its parent node by node, again after the
  unmount hooks; a text, html or multi anchor removal does nothing once its
  node is detached.
- Every VNode has `detachRefs()` (no DOM work; multi, list, toggler, catcher
  and component nodes forward it), which `remove()` of a block calls. A
  component tracks no refs: upstream checked `isConnected` on every signal ref
  and set-like ref element it had bound, after each of its patches.
- One listener per kind is made once per kind. In a root not listened on, a
  synthetic `submit` does not reach its handlers either, as `change` does not:
  only composed events, which the document's listener also sees, do.
- The modifier mask is the one parse every listener reads.

**Context copies and allocations.**

- The compiler copies the context for values read later only when a later
  `t-set` of the same template can write a variable that code reads (a called
  template's reads are not known: any); a component's slots share that copy
  too, where they took one each. In Odoo's 3491 templates (2026-10-19), 127
  places in 55 templates are copied.
- Nested loop items are made under the outer item's prototype so the outer
  item does not become a prototype (V8 deoptimizes a fresh object made one);
  only a context variable assigned at event time by a bare-called template
  could tell the difference.
- A slot without a slot scope and a bare t-call render in the given context
  because a new context under one made in this render costs V8 about 1.6 µs
  and 1.2 KB; only a bare-name `t-model.proxy` can tell.

**Odoo's stakes.**

- A directive on a `t-set-slot` node: Odoo's 15 such sites (a `t-if` on the
  slot node) rely on the slot being there: `hasSlot()` in `ViewLayout`,
  `props.slots.collapse` in `BuilderRow`.

**Build and debugging.**

- Two builds of a commit are the same bytes, since a clean build is dated by
  its commit.
- Several debug texts are shorter than in earlier fork builds, and `debug` is
  built from `DEBUG_CHANNELS`.

## Odoo integration contract

Odoo reaches into these internals; a refactor must keep their shape:
Block strings, block types (called with their handler list as third
argument), handler data and `mainEventHandler` are internal; Odoo reads
none of them. A slot descriptor is `{__render, __ctx, __owner, __scope?, ...attrs}`
(`__render` static, run with `__owner`), and a t-call body sits in the call
context under the `zero` / `zeroCtx` helper symbols; Odoo reads none of them.
Odoo's one VNode, o_spreadsheet's `VPortal`, extends the text VNode
(`blockDom.text("").constructor`), so a method added to VNodes needs a
default there. `node.renderFn` is an own function, wrapped and called unbound
(`web/core/utils/render_hooks.js`, HOOT, o_spreadsheet);
`app._compileTemplate(name, template)` is wrapped per instance
(`web/core/template_compile_cache.js`); `node.__owl__.children` is read as a
snapshot of the committed children; `App.version` + `__info__.hash` scope the template compile cache.

## Checks before re-vendoring into Odoo

1. `node tools/odoo_migration/compile_templates.mjs <roots>` (the module
   roots, e.g. Odoo's `addons` and `odoo/addons`, `l10n`, `agromarin`,
   `design-themes`; or file paths on stdin): every Odoo template file compiles
   with the new build. An unknown custom directive is a failure; a missing
   called template is an unavailable context.
2. `node tools/odoo_migration/compile_inherited_templates.mjs <roots>`: every
   template compiles after Odoo's own template inheritance, with the new and
   the old build; it must print no `REGRESSION` line. The same comparison
   covers the templates inside view archs (each `[t-name]` under a
   `<templates>` in the roots' non-static XML, as Odoo's kanban arch parser
   takes them) and flags an inherited view setting a `t-att*` attribute on a
   `<t>`, which the old build dropped and the new one rejects. It reads the
   view files, not a database, so an arch built by an `xpath` that inserts
   such a node is still only seen by the HOOT suites. `FREE_NAMES=1` also
   lists the component templates reading a context name nothing sets.

   Both take the new build from `OWL` (an Owl checkout; default the one the
   script is in), at its `packages/owl/dist/owl.es.js`, so `npm run build`
   first; a build whose `__info__.hash` names other sources than those beside
   it (a commit whose `packages/*/src` differ, or another dirty state) is
   refused as stale, as is a root that does not exist, each with exit 2. A
   root holding no `static/src/**/*.xml` (for the second, nor any view file)
   is skipped with a note on stderr, so a module family can be passed whole;
   a run in which every root is such is refused with exit 2. Both stop first
   on a Node older than `.node-version`. The second also reads `WEB`, Odoo's `addons/web` (default: in
   `../odoo` beside the Owl checkout, else beside the checkout a worktree was
   added from), its
   `template_inheritance.js` and the Odoo checkout's `node_modules/xpath`, and
   `OLD`, the old build's `owl.es.js` (default: the one vendored in `WEB`). A
   missing build, `WEB` or `OLD` exits 2 naming it.

   `node tools/odoo_migration/compare_codegen.mjs <roots>` goes further than
   acceptance: it compiles every static template and every inline `xml` ``
template of the roots (`static/{src,tests}/\*_/_.js`) with the vendored
compiler and the new one and exits 1 on any whose code differs or that only
the new one rejects (`--old`, `--new`name other compiler modules).`npm run
   verify` runs it over the Odoo checkout and its sibling module repos, after
   the build.

3. Every HOOT suite, with the old and the new build, compared test by
   test (`node tools/odoo_gate.mjs` does it for the suites it is given, and
   `--bisect` finds the commit that breaks one HOOT test), on a database where every module whose tests they run is
   installed: `@web`'s `WebSuite`, `MobileWebSuite`, `AddonSuite` and
   `MobileAddonSuite` (the other addons' unit tests), `@mail`'s `MailSuite`
   and `MobileMailSuite`, and each addon's own runner (`WebsiteSuite`,
   `PointOfSaleSuite`, `im_livechat`'s `ExternalTestSuite`, agromarin's
   `*HootSuite`, …; `grep -rln "HOOTCommon\|/web/tests" --include=*.py` over
   the module roots lists them). `WebSuite` alone does not reach the addons'
   kanban archs or their components. Vendor the three files together (`owl.es.js`,
   `owl.runtime.es.js`, `owl.compiler.es.js`): a compiler from another build
   is refused. Odoo's `web/tests/test_esm_pipeline.py` checks the compiler
   module's shape (it imports nothing since the compiler registers itself).

`npm run vendor:odoo` (`tools/vendor_odoo.mjs`) builds the committed checkout
and copies the three files into Odoo's `web/static/lib/owl/`, writing the full
commit, the three sha256 (exactly those three: a stray pin is dropped) and the
version into the `owl` entry of `web/static/lib/versions.json` (nothing else
in it changes); `-- --check` only compares the build with both and exits 1 on
a difference, or on what Odoo's `tooling/assets/check_vendored_libs.py`
rejects (checksums pinning other files than the three, the entry's `probe`
missing from its file, a file whose `var buildHash` is not the commit's). The
version is the build's `var version` (`owl-runtime/src/version.ts`, what
Odoo's probe reads); a `packages/owl/package.json` saying otherwise is
refused. A checkout with any uncommitted change to a tracked file (sources,
build scripts, `package.json` files, the lockfile, tsconfigs alike) or an
untracked file under `packages/*/src` is refused; other untracked files are
not. A commit no remote branch contains (as of the last fetch) is refused too,
so Odoo never pins a commit no other clone can fetch (`--allow-unpushed`
overrides it); `--check` reports a pinned commit no remote branch contains.
A commit not tagged `v<version>` is refused as well (`--allow-untagged`
overrides it), so every vendored build is a release.
`--odoo <path>` names the Odoo checkout, default only `../odoo` beside this one.

`npm run release -- <version>` (`tools/release.mjs`) makes that release: the
fork's versions are `3.0.0-marin.N`, which semver orders after upstream's
`3.0.0-alpha.49`, and a version that does not follow the current one is
refused, as is a checkout with an uncommitted change. It writes the version
into `owl-runtime/src/version.ts`, every package's `package.json` (the
`@odoo/owl*` dependencies too) and the lockfile, prepends to
`doc/v3/owl/changelog_marin.md` the subjects of the commits since the previous
`v*` tag (since `4bd42fe7`, upstream's `[REL] v3.0.0-alpha.49`, for the first
release), grouped by tag, commits `[REL] v<version>` and tags it. Push the tag
with the branch (`git push origin 3.0-marin v<version>`), then vendor.
Upstream's release script (push to master, GitHub release, `npm publish`) is
removed.

The compilation checks destroy each temporary App, including failed ones.
The first exits with a failure status for compilation errors, the inheritance
comparison for regressions or malformed XML. Both print their excluded input
counts: unavailable contexts and JSDOM-only errors in the raw scan; unresolved
primary templates, absent extension targets and JSDOM-only comparisons in the
inheritance scan. These compilation checks measure compiler acceptance;
rendering and application behavior are covered by the HOOT comparison.
`OWL_DEBUG=template,scope,lifecycle` enables debug logs. Declaration builds use
the installed generator with the same Node as the build;
`NODE_DEBUG=owl-build` logs its invocations. Published declarations include
global Map and WeakMap upsert augmentations, verified by compiling a consumer
outside the checkout without its ambient types.

## Test suites beyond upstream's

`npm test` runs the four packages' suites, then the tooling tests
(`test:tools`). `npm run verify` (`tools/verify.mjs`) runs every step even after one fails and
prints a table of results and durations, exiting 1 if any failed: each
package's tests and type check, the tooling tests (`test:tools`) and type
check, lint (type-aware, with `await-thenable`), formatting, the package,
declaration, devtools, playground and both documentation builds, and a parse
and `ruff --select F,E9` of the Python codemods in `tools/odoo_migration/`
(skipped without a `ruff` on `PATH` or in a virtualenv of the workspace
holding the checkout, `<workspace>/*/bin/ruff`); `npm run verify -- <filter>` runs the steps whose
name contains it. Lint and formatting cover the tooling's `.ts` and `.mjs`
too. Package tests share the strict
console check and retain the last 100 debug events on failure. Set
`OWL_DEBUG=reactivity,effect,scope,lifecycle` to enable traces throughout a
suite. Tests of the logging defaults explicitly control their channels.
`--reporter=default` shows trace totals even when Vitest would select its
agent reporter, which hides passing-test console output.

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
  no expected failure, and each of its 18 behavioural cases (design choices it
  only characterizes) must return the verdict pinned there (owl: lazy, no
  subscription, `Object.is`, `batch` returns its value, post-write, FIFO
  cleanups, ...). Owl-core tests require an assertion each.
- `owl-compiler/tests/expression_fuzz.test.ts`: random expressions, compiled,
  against native evaluation.
- `owl-runtime/tests/compiler/template_fuzz.test.ts`: random templates,
  rendered and patched, against a reference renderer.
- `owl-core/tests/reactivity_model.test.ts`: random programs of signals,
  computeds (reading computeds, writing signals, creating effects), effects
  and immediate effects (nested, detached, disposed), batches, `untrack` and
  promise callbacks queued among the writes, against the executable model of
  `reactivity_model.ts`: which effect or computed ran, on which values, and
  when each promise callback ran, must match (`OWL_REACTIVITY_CASES`, default
  2000; a failure prints its seed and the program reduced to what still
  fails). With `OWL_REACTIVITY_BUILD` naming an `owl.es.js` and
  `OWL_REACTIVITY_BUILD_MODE=af18b4f5`, it also runs af18b4f5's build, on the
  programs that build already ran as the model says, against the model in
  that build's mode. It fails on the ordering 3bd30878 fixed, and found the
  defects fixed in 15677748 to f9212707.
- `owl-runtime/tests/components/model_based.test.ts`: random render sequences
  (slow hooks resolved out of order, lists, `t-memo`, `selector`, a slot, an
  error boundary) settling on the render of the final state.
