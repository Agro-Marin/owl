# Effects

An effect is a function that subscribes to reactive values and re-runs whenever
its dependencies change. It is executed immediately on creation, and subsequent
re-runs are batched after a microtask:

```js
const s = signal(3);
const d = computed(() => 2 * s());

const cleanup = effect(() => {
  console.log(d()); // logs 6
});

s.set(4);
// nothing happens immediately
await Promise.resolve();
// now 8 is logged — the effect was re-executed

cleanup();
// the effect is now inactive
s.set(5);
await Promise.resolve();
// nothing happens
```

The return value of `effect()` is a cleanup function that stops the effect.

Effects react to [signals](signals.md), [computed values](computed_values.md),
and [proxy](proxies.md) properties alike. See [Reactivity](reactivity.md) for
the overall model.

## Cleanup within effects

If the effect function itself returns a function, that function is called before
each re-run, allowing resource cleanup:

```js
effect(() => {
  const handler = () => console.log(someSignal());
  window.addEventListener("resize", handler);
  return () => window.removeEventListener("resize", handler);
});
```

## Nested effects

When `effect()` is called while another effect is running, the new effect
becomes a **child** of the running one. The child's lifetime is tied to the
parent: whenever the parent re-runs or is disposed, the child is disposed
first — its cleanup function runs and all its subscriptions are released.

```js
effect(() => {
  // parent
  console.log("parent");
  effect(() => {
    // child, owned by parent
    console.log(someSignal());
    return () => console.log("child cleanup");
  });
});
```

Each time the parent re-runs, the previous child is disposed and a fresh one
is created (logging `"child cleanup"` before every re-run). When the parent
itself is disposed, the child is disposed too.

An effect created while a [computed](computed_values.md)'s getter runs belongs
to that computed in the same way: it is disposed before the getter runs again,
and when the computed is disposed (with its scope, or once its last observer
leaves it), so a getter that creates an effect on every run keeps one alive,
not one per recompute. If both are due after the same change, the computed
recomputes first: the effect of its previous run is disposed, not run again.
This holds for a `detached` computed too, and for a
[selector](computed_values.md#selectors)'s source and an
[`asyncComputed`](computed_values.md)'s fetcher (its synchronous part: what
runs after an `await` has no owner).

An effect created while a component renders (from a template helper, or a
getter that lazily creates an `asyncComputed`) belongs to the component: it
lasts across renders and is disposed with the component, so a value the
component memoizes keeps its effect. Memoize it: an effect created on every
render is a new one each time, and they pile up until the component is
destroyed.

A scope is an ownership root: an effect created while a component or a plugin
is set up belongs to no computation, even when that setup happens during a
render (a child component) or an effect (plugins started from a resource).
Use [`useEffect`](#useeffect) to bind it to the scope.

This ownership is **implicit** — any `effect()` call made while another effect
is on the call stack is attached to that effect, even if it happens inside a
helper called from the parent's body. Be especially careful with conditional
creation:

```js
let created = false;
effect(() => {
  // B
  someSignal();
  if (!created) {
    created = true;
    effect(() => {
      // A, created only once — but owned by B
      otherSignal();
    });
  }
});
```

Here A is created on B's first run and becomes B's child. The next time B
re-runs (e.g. because `someSignal` changed), B's previous children are
disposed — A is silently shut down. Since the `created` flag prevents A from
being recreated, A is now dead and no longer reacts to `otherSignal` changes.

If you need an inner effect with an independent lifetime, create it with
`{ detached: true }`: it belongs to nothing, and whoever created it must dispose
it.

## Errors

An effect that throws does not stop anything else. The other effects notified
by the same change still run, and so do the components that render from it;
the error surfaces once, as an unhandled promise rejection (or, for an
`immediateEffect`, as an exception thrown from the write that triggered it,
after the other immediate effects ran).

The failed effect stays subscribed to what it read before throwing and runs
again when one of those values changes:

```js
const items = signal([]);
effect(() => {
  console.log(items()[0].name); // throws while items is empty
});
items.set([{ name: "a" }]); // the effect runs again and logs "a"
```

An effect whose very first run throws is disposed before the error reaches
the caller of `effect()`, which never received a function to dispose it with.

## useEffect

In components, use the `useEffect` hook instead of raw `effect()`. It is
automatically cleaned up when the component is destroyed:

```js
class MyComponent extends Component {
  static template = xml`<div/>`;

  setup() {
    const value = signal(0);
    // equivalent to: onWillDestroy(effect(() => { ... }))
    useEffect(() => {
      console.log(value());
    });
  }
}
```

`useEffect` can also be called inside a [plugin](plugins.md)'s `setup`. Individual
plugins don't have their own lifetime, though: the effect is bound to the
lifetime of the shared plugin manager, and is disposed only when that manager
is destroyed.

## untrack

Executes a function without tracking any reactive dependencies. Reads inside
the function do not create subscriptions:

```js
const s = signal(1);
const c = computed(() => {
  const tracked = s();
  const notTracked = untrack(() => s());
  return tracked + notTracked;
});
// c depends on s only once (the tracked read)
```

`untrack` stops the tracking, not the [ownership](#nested-effects): an
`effect()` created inside `untrack` still belongs to the effect, computed or
render whose run it happens in, and is disposed with that run (an effect's or
a computed's next run, a render's component). An effect meant to outlive it is
created `detached`:

```js
let disposeInner;
effect(() => {
  outerSignal();
  disposeInner ??= effect(
    () => {
      innerSignal();
    },
    { detached: true }
  );
});
// disposeInner() must be called explicitly when the inner effect is no longer needed
```
