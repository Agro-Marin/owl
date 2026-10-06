# Computed Values

A computed value is a lazily-evaluated derived value. It tracks its dependencies
automatically and only recomputes when accessed and at least one dependency has
changed:

```js
const s1 = signal(3);
const s2 = signal(5);
const d1 = computed(() => 2 * s1());
const d2 = computed(() => d1() + s2());

d1(); // evaluates the function, returns 6
d2(); // evaluates d2, does not reevaluate d1, returns 11
d2(); // returns cached result immediately
s2.set(6);
d2(); // evaluates d2, does not reevaluate d1, returns 12
```

Dependency tracking is dynamic: only the values read during the **last**
evaluation are tracked. If a branch is not taken, the values it would have
read are not subscribed to.

A getter that writes a value it has read leaves the computed out of date as
soon as it returns: the next read evaluates it again, against what it wrote. A
getter that initializes what it reads (`if (!cache()) cache.set(...)`) thus
runs once more, then caches; one that sets a signal back to the value it
read before returning stays up to date (default equality only, as for any
reader of a signal). An effect, in the same position, does not run
again for its own write: an effect that writes the source of a computed it
read keeps the value of the computed it read, as it keeps the value of a
signal, and runs when a later write changes the computed from that value.

A computed value is read-only by default: its type
(`ReadonlyReactiveValue`) has no `.set()`, and calling it anyway throws an
`OwlError`. To make it writable, provide a `set` option (see below).

Computed values build on [signals](signals.md) and other reactive reads. See
[Reactivity](reactivity.md) for the bigger picture.

## Writable Computed

It is possible to provide a custom `set` function to make a computed value
writable:

```js
const s = signal(3);
const triple = computed(() => 3 * s(), {
  set: (value) => s.set(value / 3),
});

triple(); // returns 9
triple.set(6); // sets s to 2
s(); // returns 2
triple(); // returns 6
```

## Custom Equality

After a recompute, a computed value notifies its observers only when the new
result differs from the previous one (`Object.is` by default). A getter that
builds a fresh object on every run therefore always notifies, even when the
contents are identical:

```js
const todos = proxy([...]);
const visible = computed(() => todos.filter((t) => !t.done));
```

Here, adding a `done` todo recomputes `visible` to a new array with the same
contents — and everything reading `visible()` re-runs for nothing. The
`equals` option replaces the comparison:

```js
const visible = computed(() => todos.filter((t) => !t.done), {
  equals: shallowEqual,
});
```

With [`shallowEqual`](utils.md#shallowequal), an equal result stops the
propagation right there: observers are not notified, and `visible()` keeps
returning the previous array (stable identity). Dependents further down the
graph are not even recomputed.

Passing `equals: false` disables the comparison entirely: every recompute
notifies, even when the result is identical. This can be useful when the
getter returns a value that is mutated in place.

The comparison is skipped on the very first evaluation: a custom `equals`
never receives the initial `undefined`.

`asyncComputed` (below) accepts the same option for its resolved value: a
fetch resolving to an equal value does not notify. Note that there, the
previous value _can_ be `undefined` when no `initial` is given.

## Errors

A getter that throws produces an error instead of a value. The computed keeps
it until one of the values the getter read changes, rethrows it to every
reader, and is tracked like a value: a reader that caught the error runs again
once the getter recovers.

```js
const s = signal(-1);
const root = computed(() => {
  if (s() < 0) throw new Error("negative");
  return Math.sqrt(s());
});
effect(() => {
  try {
    console.log(root());
  } catch (e) {
    console.log(e.message); // "negative"
  }
});
s.set(4); // the effect runs again and logs 2
```

## Selectors

A list that highlights its selected row reads the selection once per row: with
`row.id === this.state.selected` in each row, every row depends on
`selected`, and a selection change renders all of them. `selector(source)`
returns a function `isSelected(key)` that a row reads instead: a computation
reading `isSelected(key)` depends on the answer for that key only, so a change
from `a` to `b` notifies the readers of `a` and of `b`, no other.

```js
class List extends Component {
  static template = xml`
    <ul><Row t-foreach="this.rows" t-as="row" t-key="row.id"
             row="row" isSelected="this.isSelected"/></ul>`;
  static components = { Row };
  state = proxy({ selected: null });
  isSelected = selector(() => this.state.selected);
}

class Row extends Component {
  static template = xml`
    <li t-att-class="{ on: this.props.isSelected(this.props.row.id) }"
        t-out="this.props.row.label"/>`;
  props = props();
}
```

Selecting another row renders two `Row`s and not the list. The rows must be
components (or read the selector in a computation of their own): a list that
reads `isSelected(row.id)` for every row in its own template depends on every
key, and renders as a whole.

Keys are compared with `Object.is`. A read outside any computation answers
without subscribing; inside a `batch`, it already sees a source change made
earlier in the batch. A source that throws makes every key throw that error;
its readers run again once the source recovers. A selector follows its source
only while a computation reads one of its keys, and stops once none does. Like
`computed`, a selector is disposed with the scope it is created in (pass
`{ detached: true }` to keep it), after which it keeps its last answer and
tracks nothing.

## Async Computed Values

> **Experimental.** `asyncComputed` is still shaking out; the exact API
> (option names, method surface, cancellation semantics) is subject to
> change in future versions. Use with that caveat in mind.

An `asyncComputed` is the asynchronous counterpart to `computed`. It runs a
fetcher that returns a `Promise` (a plain value is taken as already resolved),
exposes the resolved value as a reactive read, and re-runs the fetcher whenever
any of its tracked dependencies change:

```js
const userId = signal(1);

const user = asyncComputed(
  async ({ abortSignal }) => {
    const id = userId();
    const res = await fetch(`/api/users/${id}`, { signal: abortSignal });
    return res.json();
  },
  { initial: null }
);

user(); // current value (initial → resolved → next resolved)
user.loading(); // reactive boolean: true while a run is in flight
user.error(); // reactive Error | null
user.refresh(); // re-run the fetcher even if nothing changed
user.dispose(); // tear down (auto-called when the surrounding scope dies)
user.currentPromise(); // promise that resolves once no run is in flight
```

The `abortSignal` argument follows the same convention as
[`onWillStart`](scope.md#async-cancellation): it fires when the run is
superseded (deps changed, or `refresh()` called), when the surrounding
[scope](scope.md) is destroyed, or when the effect, computed or render that
created the `asyncComputed` runs again or is disposed (see
[nested effects](effects.md#nested-effects)). Any `fetch` keyed to it is cancelled
automatically; the resulting `AbortError` is silently dropped.

While a fetch is in flight, the previous resolved value remains visible via
`user()` — branch on `user.loading()` if you want a different visual.

When created inside a component or a plugin's `setup`, `asyncComputed` cleans
up automatically on destroy. Outside any scope, you must call `.dispose()`
yourself.

### Awaiting the current run

`currentPromise()` returns a promise that resolves as soon as no run is in
flight: if a run is currently running, or about to start (a dependency
changed, or `refresh()` was called, in the current tick), it resolves once that
run — or any run that supersedes it — settles, otherwise it resolves
immediately. It never
rejects; a fetcher error is reported through `error()`, not by rejecting.

This pairs naturally with [`onWillStart`](scope.md) to hold the first render
until the initial data is available:

```js
class UserCard extends Component {
  static template = xml`<div t-out="this.user()?.name"/>`;
  user = asyncComputed(async ({ abortSignal }) => {
    const res = await fetch(`/api/users/${userId()}`, { signal: abortSignal });
    return res.json();
  });
  setup() {
    onWillStart(() => this.user.currentPromise());
  }
}
```

The component mounts only once the first fetch settles, so `this.user()` is
already populated on the initial render. Later re-runs (a dependency changed,
or `refresh()`) update the value reactively without blocking, and you can
branch on `loading()` to show a spinner for those.

### Tracking only happens before the first `await`

Like every reactive system that supports async derivations, dependency
tracking captures only the reads that happen on the **synchronous** path of
the fetcher — that is, before the first `await`. Reads after an `await` are
not tracked, because by the time the continuation runs, the reactive context
is no longer active:

```js
// `filter` is read after `await` — changes to it will not re-run the fetcher
const results = asyncComputed(async ({ abortSignal }) => {
  const id = userId();
  const res = await fetch(`/api/users/${id}`, { signal: abortSignal });
  const filter = search();
  return (await res.json()).filter((u) => u.name.includes(filter));
});
```

The idiomatic fix is to split fetching from deriving: use `asyncComputed` for
the fetch, and a regular `computed` for any further transformation that
depends on synchronous reactive state:

```js
// asyncComputed for fetching, computed for deriving
const data = asyncComputed(async ({ abortSignal }) => {
  const id = userId();
  const res = await fetch(`/api/users/${id}`, { signal: abortSignal });
  return res.json();
});

const results = computed(() => {
  const filter = search();
  return (data() ?? []).filter((u) => u.name.includes(filter));
});
```

This split is also a free performance win: changing `search` re-runs the
filter without triggering a network request.

### Errors

Errors thrown by the fetcher (sync or async) populate `error()` and clear
`loading()`; a thrown value that is not an `Error` is wrapped in one, with the
value as its `cause`. The next successful run clears the error. `AbortError` is treated
as a cancellation, not a real error — it never reaches `error()`.

### No `.set` (read-only)

Unlike `computed`, `asyncComputed` has no `set` option. Asynchronous writes
(PUT/POST against an API) are conceptually a different operation and are best
modelled with a plain async function rather than wrapped behind a reactive
read.
