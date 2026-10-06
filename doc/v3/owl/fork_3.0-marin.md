# The 3.0-marin fork

`3.0-marin` (Agro-Marin/owl) is `v3.0.0-alpha.49` plus the fork's commits
(`git log v3.0.0-alpha.49..3.0-marin`). Odoo vendors its build as
`web/static/lib/owl/owl.es.js`; `web/static/lib/versions.json` names the commit.
This page lists what the fork adds and where it deliberately behaves
differently from upstream.

## Added API

| API                                      | What it does                                                                                                                        | Reference                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `immediateEffect(fn)`                    | an effect that runs synchronously on each change, not in the next microtask                                                         | [effects](reference/effects.md)                                     |
| `observe(target, callback)`              | OWL 2's `reactive(target, callback)`: a view of `target` that calls `callback` once a value read through it changes                 | [proxies](reference/proxies.md#observe)                             |
| `computed(fn, { detached: true })`       | a computed that outlives the scope that created it                                                                                  | [computed values](reference/computed_values.md)                     |
| `selector(source)`                       | `isSelected(key)`, whose readers depend on the answer for their key only                                                            | [computed values](reference/computed_values.md#selectors)           |
| `t-memo="[deps]"`                        | on a keyed `t-foreach`: an item whose dependencies are unchanged keeps its previous content (child components included)             | [template syntax](reference/template_syntax.md#memoized-list-items) |
| `setDebug(channels)`, `setDebugSink(fn)` | opt-in debug logging per channel (reactivity, effect, computed, scope, plugin, scheduler, fiber, lifecycle, error, template, event) | [debug logging](reference/debug_logging.md)                         |
| `@odoo/owl/runtime`                      | the runtime without the template compiler (`owl.runtime.es.js`, 34% smaller), for pages whose templates arrive precompiled          | —                                                                   |
| `@odoo/owl/compiler`                     | the compiler alone (`owl.compiler.es.js`); importing it installs it into a runtime build loaded as `@odoo/owl`, which then compiles | —                                                                   |

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

## Odoo integration contract

Odoo reaches into these internals; a refactor must keep their shape:
`node.renderFn` is an own function, wrapped and called unbound
(`web/core/utils/render_hooks.js`, HOOT, o_spreadsheet);
`app._compileTemplate(name, template)` is wrapped per instance
(`web/core/template_compile_cache.js`); `node.__owl__.children` is read as a
snapshot; `App.version` + `__info__.hash` scope the template compile cache.

## Checks before re-vendoring into Odoo

1. `tools/odoo_migration/compile_templates.cjs`: every Odoo template file
   compiles with the new build.
2. `tools/odoo_migration/compile_inherited_templates.mjs`: every template
   compiles after Odoo's own template inheritance, with the new and the old
   build; it must print no `REGRESSION` line. `FREE_NAMES=1` also lists the
   component templates reading a context name nothing sets.
3. The `@web` HOOT suites (`WebSuite`, `MobileWebSuite`) with the old and the
   new `owl.es.js`, compared test by test.

## Test suites beyond upstream's

- `owl-core/tests/conformance.test.ts`: the cross-framework reactive
  conformance suite (`reactive-framework-test-suite`); 175 of 178 core cases,
  the three deliberate divergences marked as expected failures.
- `owl-compiler/tests/expression_fuzz.test.ts`: random expressions, compiled,
  against native evaluation.
- `owl-runtime/tests/compiler/template_fuzz.test.ts`: random templates,
  rendered and patched, against a reference renderer.
- `owl-runtime/tests/components/model_based.test.ts`: random render sequences
  (slow hooks resolved out of order, lists, `t-memo`, `selector`, a slot, an
  error boundary) settling on the render of the final state.
