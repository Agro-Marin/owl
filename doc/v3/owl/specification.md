# Behaviour specification

This page states the behaviour OWL guarantees, from reactivity and proxies to rendering, events and templates, one rule per bullet, each naming the test that asserts it; `node tools/spec_check.mjs`, a verify step, fails any rule whose test is missing.
[The 3.0-marin fork page](fork_3.0-marin.md) stays as the history of where the fork differs from upstream.

## Reactivity

### Conformance

- **The cross-framework suite**: OWL passes every behavioural case of the cross-framework reactivity conformance suite, none of them an expected failure.
  `[test: packages/owl-core/tests/conformance.test.ts › every behavioral case has a pinned verdict, and every pinned verdict a case]`
  `[test: packages/owl-core/tests/conformance.test.ts › no conformance case is an expected failure]`

### Cycles

- **A computation reading itself**: a computation read while it runs throws `Cycle detected: <name> reads its own value` instead of recursing, after one run.
  `[test: packages/owl-core/tests/computed.test.ts › a computed reading itself fails with a cycle error, after one run]`
  `[test: packages/owl-core/tests/computed.test.ts › two computeds reading each other fail with a cycle error]`
- **Recovery**: a computed that catches its cycle error computes normally once it stops reading itself.
  `[test: packages/owl-core/tests/computed.test.ts › a computed that caught its cycle error recovers once it stops reading itself]`

### Bringing a computed up to date

- **A batch**: bringing a computed up to date is a batch: an `immediateEffect` or `observe()` callback that a write or a computed's change queues meanwhile runs once the outermost computed being evaluated is up to date (for a read, once the reader holds its value), never in the middle of an evaluation it could read.
  `[test: packages/owl-core/tests/immediate_effect.test.ts › an immediate effect that put a computed out of date runs once it is recomputed, not inside it]`
  `[test: packages/owl-core/tests/immediate_effect.test.ts › an immediate effect reading back through a computed what its getter wrote runs once it is up to date]`
  `[test: packages/owl-core/tests/specification.test.ts › an observe() callback reading back through a computed what its getter wrote runs once it is up to date]`
- **No cycle error**: an `immediateEffect` or `observe()` callback that reads back through a computed what its getter wrote, or that reads a computed which changed while another reader pulled it, gets the computed's up-to-date value, without a cycle error and without a re-entrant recompute.
  `[test: packages/owl-core/tests/immediate_effect.test.ts › an immediate effect reading back through a computed what its getter wrote runs once it is up to date]`
  `[test: packages/owl-core/tests/specification.test.ts › an observe() callback reading back through a computed what its getter wrote runs once it is up to date]`
  `[test: packages/owl-core/tests/immediate_effect.test.ts › a reader keeps following a computed whose evaluation queued an immediate effect writing its source]`
- **Its writes**: what such a callback writes reaches the computed's reader as any later write does, and the reader keeps following the computed.
  `[test: packages/owl-core/tests/immediate_effect.test.ts › a reader keeps following a computed whose evaluation queued an immediate effect writing its source]`
- **Owner before owned**: an owner whose sources are being checked does not run before the effect it owns.
  `[test: packages/owl-core/tests/immediate_effect.test.ts › an owner whose sources are being checked does not run before the effect it owns]`
- **Disposed during a check**: a computation disposed while its sources are checked stops checking them.
  `[test: packages/owl-core/tests/immediate_effect.test.ts › an effect disposed while its sources are checked stops checking them]`

### Ownership

- **An effect belongs to the run that creates it**: an effect created while a computation runs belongs to that computation, tracked or not: `untrack` keeps the owner.
  `[test: packages/owl-core/tests/ownership.test.ts › created inside untrack is still the computed's]`
  `[test: packages/owl-core/tests/ownership.test.ts › by a getter read through an observe() view, inside untrack, belongs to the effect running]`
- **An effect's effect**: an effect created by an effect's run is disposed before that effect runs again and when it is disposed.
  `[test: packages/owl-core/tests/ownership.test.ts › within an effect is disposed when that effect re-runs and when it is disposed]`
- **A computed's effect**: an effect created by a computed's getter, a detached computed's included, is disposed before the getter runs again and when the computed is disposed.
  `[test: packages/owl-core/tests/ownership.test.ts › is disposed before the computed recomputes: N recomputes leave one, not N]`
  `[test: packages/owl-core/tests/ownership.test.ts › of a detached computed is disposed on recompute and when the flush disposes the computed]`
- **A selector source's effect**: an effect created by a selector's source is disposed before the source runs again and when the selector stops following it.
  `[test: packages/owl-core/tests/ownership.test.ts › an effect its source creates is disposed when the source runs again, and when no key is read]`
- **An `observe()` callback's effect**: an effect created by an `observe()` callback is disposed before the callback runs again.
  `[test: packages/owl-core/tests/specification.test.ts › an effect an observe() callback creates is disposed before the callback runs again]`
- **A render's effect**: an effect created while a component renders belongs to the component and lasts until the component is destroyed.
  `[test: packages/owl-runtime/tests/components/reactivity.test.ts › an effect its render creates inside untrack is the component's: disposed with it]`
  `[test: packages/owl-runtime/tests/components/reactivity.test.ts › an effect its render creates outlives the component's re-renders, until it is destroyed]`
- **A scope is an ownership root**: an effect created while a scope is set up, even inside an effect's run, belongs to no computation.
  `[test: packages/owl-core/tests/ownership.test.ts › an effect created in a scope's run inside an effect is not that effect's]`
- **Detached effects**: `effect(fn, { detached: true })` creates an effect owned by nothing, which outlives the computation that created it.
  `[test: packages/owl-core/tests/ownership.test.ts › with { detached: true } belongs to nothing: it outlives the effect that created it]`
  `[test: packages/owl-core/tests/effect.test.ts › creating A with { detached: true } escapes B's ownership]`
- **Owner first**: when a computed and an effect it owns are both due after one change, the computed runs first, and the effect of its previous run is disposed instead of run again.
  `[test: packages/owl-core/tests/ownership.test.ts › does not run again for a write its computed is recomputed for: the computed runs first]`
  `[test: packages/owl-core/tests/ownership.test.ts › an immediate one does not run again for a write its computed is recomputed for]`
- **An owned `asyncComputed`**: an `asyncComputed` is disposed whole by its owner: it is no longer loading, and the result of its abandoned run is ignored.
  `[test: packages/owl-core/tests/ownership.test.ts › created by an effect is disposed by its re-run: no longer loading, a late result is dropped]`

### Disposal

- **An effect takes its computeds along**: disposing an effect disposes the computeds it was the last observer of, releasing their sources.
  `[test: packages/owl-core/tests/computed.test.ts › an effect disposed unsubscribes the computed it was the last observer of]`
  `[test: packages/owl-core/tests/ownership.test.ts › is disposed with the computed its last observer's dispose cascades to]`
- **A computed no run reads any more**: a re-run that stops reading a computed nothing else reads disposes it at the flush, a computed reading no source included.
  `[test: packages/owl-core/tests/computed.test.ts › effect that stops reading a computed detaches it at the flush]`
  `[test: packages/owl-core/tests/ownership.test.ts › is disposed when the computed's last reader stops reading it]`
- **Read again before the flush**: such a computed is kept when it is read again before the flush.
  `[test: packages/owl-core/tests/computed.test.ts › computed re-observed before the flush is not disposed]`
  `[test: packages/owl-core/tests/computed.test.ts › a computed one reader stops reading and another reads in the same flush stays]`
- **A change seen during a run**: an effect that saw a computed it read change during its run stays its observer, so another reader letting the computed go does not dispose it.
  `[test: packages/owl-core/tests/computed.test.ts › an effect still follows a computed it saw change during its run when its other reader lets it go]`
- **Read again after its disposal**: a disposed computed read again recomputes, returning a new object for an object result, and creates again the effects its getter creates, owned by it.
  `[test: packages/owl-core/tests/specification.test.ts › a computed the flush disposed recomputes a new object when read again]`
  `[test: packages/owl-core/tests/ownership.test.ts › of a detached computed is disposed on recompute and when the flush disposes the computed]`
- **`untrack` inside a viewed getter**: `untrack` inside a getter reached through an `observe()` view keeps that getter's reads of other proxies off the view.
  `[test: packages/owl-core/tests/observe.test.ts › untrack keeps a getter's reads of other proxies off the view only inside the getter]`
- **A view read subscribes the view in any context**: a read through an `observe()` view, `this` in a getter it reaches included, subscribes the view even inside `untrack` or a lifecycle hook, as does what such a getter reads outside an `untrack`.
  `[test: packages/owl-core/tests/observe.test.ts › untrack keeps a getter's reads of other proxies off the view only inside the getter]`
  `[test: packages/owl-runtime/tests/components/reactivity.test.ts › an observe() view first read in onWillStart, or inside untrack, keeps calling back]`

### Writes during a run

- **A getter that writes its source**: a computed whose getter writes a source it read ends out of date; its next read checks its sources and recomputes if one changed since the getter read it.
  `[test: packages/owl-core/tests/computed.test.ts › a getter that writes a source it read ends out of date: the next read recomputes it]`
- **An effect that writes a computed's source**: an effect that writes the source of a computed it read keeps the computed's value it read, as it keeps a signal's; it runs when a later write changes the computed from that value, not when the value comes back to it.
  `[test: packages/owl-core/tests/effect.test.ts › an effect that resets a signal through a computed compares what it read, as it does for the signal]`
  `[test: packages/owl-core/tests/effect.test.ts › an effect that writes the source of a computed it read keeps tracking the computed]`
- **Forwarding**: such a computed is not recomputed when the run ends; it forwards the next write to its readers.
  `[test: packages/owl-core/tests/debug.test.ts › the reactivity and computed channels trace a write reaching a run that read it]`
  `[test: packages/owl-core/tests/effect.test.ts › a computed recomputed by a run invalidates a source that run read: it forwards the next write]`
- **A write during a check**: a computation whose check (bringing its sources up to date to see whether one changed) ran a write to a source it had checked already ends up to date on what it checked, and that source forwards it its next write.
  `[test: packages/owl-core/tests/computed.test.ts › an effect whose check ran a getter writing a source it checked already follows that source]`
  `[test: packages/owl-core/tests/immediate_effect.test.ts › an effect whose check ran an immediate effect writing a source it checked follows that source]`

### Cleanup errors

- **On a recompute**: an owned effect's cleanup that throws when its computed recomputes is reported as an unhandled rejection, and the computed's readers still get the new value.
  `[test: packages/owl-core/tests/ownership.test.ts › whose cleanup throws on a recompute: the error is reported, the readers get the new value]`
- **On a cascade**: when a dispose cascades to computeds and a cleanup throws, the dispose throws after releasing everything, the disposed effect's own cleanup and children included.
  `[test: packages/owl-core/tests/ownership.test.ts › whose cleanup throws when the computed is disposed by cascade: the dispose throws, after releasing everything]`
  `[test: packages/owl-core/tests/ownership.test.ts › whose cleanup throws when the reader's dispose cascades to it: the reader's own cleanup and effects are released]`
- **In bulk**: when a scope or the flush disposes several computeds and a cleanup throws, every computed is disposed and the error goes to the scope's `reportError` or to the flush.
  `[test: packages/owl-core/tests/ownership.test.ts › by their scope: the error is reported, every computed is disposed, the scope is destroyed]`
  `[test: packages/owl-core/tests/ownership.test.ts › by the flush, unobserved: every one is disposed, the error is reported]`
- **A failed first run**: an effect whose first run throws is disposed; the run's error is thrown and an error of that dispose is reported.
  `[test: packages/owl-core/tests/ownership.test.ts › whose cleanup throws when a reader's failed first run disposes it: the run's error is thrown, the cleanup's reported]`

### Effects disposing themselves

- **From its cleanup**: an effect its own cleanup disposes does not run again.
  `[test: packages/owl-core/tests/effect.test.ts › an effect its cleanup disposes does not run again]`
- **From its run**: an effect its own run disposes keeps no subscription, also when the run then throws.
  `[test: packages/owl-core/tests/effect.test.ts › an effect that disposes itself and then throws keeps no subscription]`
  `[test: packages/owl-core/tests/tracking.test.ts › an effect disposed by its own run releases what it reads after]`
- **Not run again by its own run's write**: an effect its own run disposes is not run again by a write later in that run.
  `[test: packages/owl-core/tests/effect.test.ts › an immediate effect that disposed itself is not run again by a write later in that run]`
- **Errors of that dispose**: when such a run throws, the run's own error is thrown and an error dropping its sources or releasing it goes to `Promise.reject`.
  `[test: packages/owl-core/tests/effect.test.ts › an effect that disposes itself and then throws keeps its error when dropping a source throws]`
- **Cleanup functions only**: an effect keeps what its run returns as its cleanup only when it is a function.
  `[test: packages/owl-core/tests/effect.test.ts › an effect keeps what it returns only when it is a cleanup function]`

### Selectors

- **One batch per change**: a selector notifies the readers of the previous and of the new key in one batch, so an immediate reader of both runs once.
  `[test: packages/owl-core/tests/selector.test.ts › an immediate reader of both keys of a change runs once]`
- **A throwing reader**: a reader of one key that throws leaves the readers of the other key notified.
  `[test: packages/owl-core/tests/selector.test.ts › a reader of the previous key that throws leaves the readers of the new key notified]`
- **A failing source**: a selector rethrows its source's error for every key, and runs its readers again once the source recovers.
  `[test: packages/owl-core/tests/selector_contracts.test.ts › a changed source failure notifies every key reader ($name)]`
  `[test: packages/owl-core/tests/selector.test.ts › a failing source is rethrown for every key, and its readers run again once it recovers]`
- **Following its source**: a selector follows its source only while a computation reads one of its keys.
  `[test: packages/owl-core/tests/selector.test.ts › a selector no computation reads any more stops following its source]`

### Async computeds

- **Waiting for a queued run**: `currentPromise()` waits for a run that a dependency change or `refresh()` queued, not only for one in flight.
  `[test: packages/owl-core/tests/async_computed.test.ts › currentPromise() right after a dependency changed waits for the run it queued]`
  `[test: packages/owl-core/tests/async_computed.test.ts › currentPromise() right after refresh() waits for the new run]`
- **Disposal**: `dispose()` sets `loading()` to false.
  `[test: packages/owl-core/tests/async_computed.test.ts › dispose() during a run leaves it not loading]`
- **A fetcher throwing synchronously**: its run keeps its abort cleanup, so disposal, a re-run or the end of its scope aborts the work it started.
  `[test: packages/owl-core/tests/async_computed_cleanup.test.ts › %s aborts a run whose fetcher threw synchronously]`

### Scopes

- **Cleanup runs unsubscribed**: destroying or rolling back a scope runs its cleanup without subscribing the computation that asked for it.
  `[test: packages/owl-core/tests/scope.test.ts › %s callbacks do not subscribe the computation requesting cleanup]`
- **Cleanup runs unowned**: an effect a destroy callback creates during a destruction or a rollback does not belong to the computation that asked for it.
  `[test: packages/owl-core/tests/specification.test.ts › an effect a destroy callback creates during %s is not the caller's]`
- **Rollback drains**: a rollback also runs the destroy callbacks registered during its cleanup, and keeps those registered before its mark.
  `[test: packages/owl-core/tests/scope.test.ts › rollback releases callbacks registered during cleanup, preserving earlier callbacks]`

### Flush scheduling

- **Only when needed**: a write schedules the effects' flush only if it queues an effect or a computed's disposal that no scheduled flush will run, so a promise callback queued before a write that queues nothing new runs before the effects it queues.
  `[test: packages/owl-core/tests/effect.test.ts › a write that queues nothing schedules no flush, whatever an earlier write queued]`
  `[test: packages/owl-core/tests/effect.test.ts › a write that queues again a disposal the flush will run schedules no flush]`
- **After its immediate effects**: a write schedules the flush at its end, after its immediate effects, so a promise callback an immediate effect queues runs before the effects the same write queued.
  `[test: packages/owl-core/tests/immediate_effect.test.ts › a microtask an immediate effect queues runs before the effects the same write queued]`

### batched

- **Latest arguments**: `batched` calls its callback once per microtask, with the arguments of the latest call.
  `[test: packages/owl-core/tests/utils.test.ts › calls the callback once per microtask, with the arguments of the latest call]`

## Proxies

### Private members and markRaw

- **A private member reached through a proxy**: a getter or setter reaching a private member through a proxy throws an `OwlError` naming the member and the class to mark with `markRaw(<Class>.prototype)`, when a class of the proxied object declares that member.
  `[test: packages/owl-core/tests/proxy.test.ts › a private member read through a getter throws an OwlError naming the key and markRaw]`
  `[test: packages/owl-core/tests/proxy.test.ts › a private member written through a setter throws the same OwlError]`
- **Another class's private member**: a private member error that no class of the proxied object causes passes through unchanged.
  `[test: packages/owl-core/tests/proxy.test.ts › a private member error the target's classes do not cause is rethrown as it is]`
- **Built-in prototypes**: `markRaw` of a built-in prototype (`Object`, `Array`, `Map`, `Set`, `WeakMap`, `Function`) throws.
  `[test: packages/owl-core/tests/proxy.test.ts › markRaw of a built-in prototype throws instead of leaving every such object unobserved]`

### Writes

- **A setter write is one batch**: a write through a setter notifies every key it changes in one batch, so an immediate reader of several of them runs once, after it.
  `[test: packages/owl-core/tests/proxy.test.ts › a setter writing its backing field runs an immediate reader once per write]`
- **An array write is one batch**: an index or length write notifies in one batch, so an immediate reader of the index, the length and the items runs once.
  `[test: packages/owl-core/tests/foreign_proxy.test.ts › an index write or a length write runs an immediate reader of the index, the length and the items once]`
- **A delete is one batch**: a delete notifies the key, its presence and the key list in one batch.
  `[test: packages/owl-core/tests/foreign_proxy.test.ts › a write, a creation or a delete runs an immediate reader of the key, its presence and the keys once]`
- **The getter a setter write compares**: a write through a setter calls the key's getter, to compare the values, only when the key is observed.
  `[test: packages/owl-core/tests/proxy.test.ts › a write through a setter calls its getter only when the key is observed]`
- **A throwing getter there**: a getter that throws during that comparison counts as a change instead of failing the write.
  `[test: packages/owl-core/tests/proxy.test.ts › a write through a setter whose getter throws until it was set succeeds, observed or not]`
- **An index past the end**: an index written past the end of an array behind its own Proxy notifies its length, also through a shallow proxy.
  `[test: packages/owl-core/tests/specification.test.ts › an index written past the end of an array behind its own Proxy notifies its length]`
  `[test: packages/owl-core/tests/foreign_proxy.test.ts › a shallow signal of it notifies an index written past the end once and hands out items as stored]`

### Collections

- **No `add` on a Map**: a Map proxy and an `observe()` view of a Map have no `add`; it reads `undefined`, as on a Map.
  `[test: packages/owl-core/tests/proxy.test.ts › a map proxy, or a view of one, has no add method, as a map has none]`
- **A set operation's argument is checked natively**: a set operation (`union`, `intersection`, …) on a proxy rejects a non-set-like argument as the native method does.
  `[test: packages/owl-core/tests/proxy.test.ts › a set operation rejects what is not set-like, as the native one does]`
- **A set operation reads what the native one reads**: it reads of its argument only what the native method reads, its `has` or its `keys()`, lazily.
  `[test: packages/owl-core/tests/proxy.test.ts › a set operation reads only what the native one reads of its argument]`
  `[test: packages/owl-core/tests/proxy.test.ts › a set operation reads a set-like through its keys iterator]`
- **Raw comparison**: a set operation compares members by their raw objects.
  `[test: packages/owl-runtime/tests/reactivity/proxy.test.ts › ES2025 set operations on deep reactive sets of objects compare raw members]`
  `[test: packages/owl-runtime/tests/reactivity/proxy.test.ts › a shallow set holding proxies compares its members with a deep set's by raw object]`
- **A set operation's result**: it returns a plain Set of the members as their set holds them, the target's first.
  `[test: packages/owl-core/tests/proxy.test.ts › a set operation answers as on the raw sets, each member as its set holds it, in order]`
- **A mutation is one batch**: a `set`, `add`, `delete` or `clear` runs an immediate reader once after it, even when the reader reads several affected keys.
  `[test: packages/owl-core/tests/collection_contract.test.ts › one Map mutation runs a reader of size, presence and value once]`
  `[test: packages/owl-core/tests/specification.test.ts › Set.add runs an immediate reader of the size and of the member once]`
  `[test: packages/owl-core/tests/collection_contract.test.ts › clear runs a reader of multiple entries once]`
- **A throwing reader**: a collection mutation whose immediate reader throws still notifies the readers of the other keys.
  `[test: packages/owl-core/tests/collection_contract.test.ts › a throwing immediate reader does not prevent other Map readers being notified]`
- **Chained writes**: `set` and `add` return the reactive collection, so chained calls stay reactive.
  `[test: packages/owl-core/tests/collection_contract.test.ts › Map.set returns its reactive collection and chained writes notify]`
  `[test: packages/owl-core/tests/collection_contract.test.ts › Set.add returns its reactive collection and chained writes notify]`
  `[test: packages/owl-core/tests/collection_contract.test.ts › WeakMap.set returns its reactive collection and chained writes notify]`
- **Upserts**: `getOrInsert` and `getOrInsertComputed` on a `Map` or `WeakMap` read and notify their entry through the proxy, with the raw, deep and shallow value rules of `get` and `set`.
  `[test: packages/owl-core/tests/collection_contract.test.ts › %s getOrInsert keeps reads, insertion and returned values reactive]`
  `[test: packages/owl-core/tests/collection_contract.test.ts › %s getOrInsertComputed normalizes the key and stored value and skips existing keys]`
- **A collection's own properties**: a collection's own properties are read with the proxy as `this`, so a subclass getter is tracked.
  `[test: packages/owl-core/tests/proxy.test.ts › a getter of a Map subclass reads the entries through the proxy]`
- **Properties apart from entries**: a collection's own properties are observed apart from its entries.
  `[test: packages/owl-core/tests/proxy.test.ts › a property of a collection and an entry of the same name are apart]`

### Shallow proxies and raw storage

- **A shallow proxy keeps a proxy**: a shallow proxy (`signal.Array`, `signal.Object`) keeps a proxy written into it, as a shallow Map keeps a proxy value.
  `[test: packages/owl-core/tests/proxy.test.ts › a shallow array and a shallow object keep the proxy written into them]`
  `[test: packages/owl-runtime/tests/reactivity/proxy.test.ts › a signal.Map hands back the proxy it was given, and tracks through it]`
- **Raw members and keys**: a Set member and a Map key are stored raw by every kind of collection proxy.
  `[test: packages/owl-core/tests/specification.test.ts › a %s collection stores a Set member and a Map key raw]`
- **A collection already holding a proxy**: a collection that held a proxy before it was wrapped finds it, deletes it and notifies its readers through it.
  `[test: packages/owl-core/tests/collection_contract.test.ts › a Set holding a proxy finds, deletes and notifies it]`
  `[test: packages/owl-core/tests/collection_contract.test.ts › a Map keyed by a proxy finds its entry, and its readers see writes to it]`
  `[test: packages/owl-core/tests/collection_contract.test.ts › clearing a Map keyed by a proxy notifies the readers of that key]`

### Property introspection

- **`hasOwnProperty`**: `obj.hasOwnProperty(k)` through a proxy subscribes to the presence of `k`, as `in` does.
  `[test: packages/owl-core/tests/proxy.test.ts › hasOwnProperty follows the presence of the key it asks about]`
- **`Object.defineProperty`**: `Object.defineProperty` through a proxy defines on the target and notifies nothing.
  `[test: packages/owl-core/tests/proxy.test.ts › Object.defineProperty through a proxy defines on the target and notifies nothing (Odoo web_studio's activeNode)]`
- **Untracked introspection**: `Object.hasOwn`, `propertyIsEnumerable` and `Object.getOwnPropertyDescriptor` through a proxy subscribe to nothing.
  `[test: packages/owl-core/tests/specification.test.ts › Object.hasOwn, propertyIsEnumerable and Object.getOwnPropertyDescriptor subscribe to nothing]`

### Locked properties

- **Handed out as is**: a locked (non-configurable, non-writable) property is handed out as it is, by collections and `observe()` views too, as the Proxy invariant requires.
  `[test: packages/owl-core/tests/proxy.test.ts › a locked property of a collection is raw]`
  `[test: packages/owl-core/tests/proxy.test.ts › an observe() view of a frozen object holding a proxy hands the proxy out]`

### Array searches

- **One atom**: `includes`, `indexOf` and `lastIndexOf` on a proxied plain array subscribe to its items as one atom.
  `[test: packages/owl-core/tests/proxy.test.ts › a search subscribes to the items as one atom, not to each index]`
- **The raw array**: they search the raw array, so an item is found by its raw object or its proxy.
  `[test: packages/owl-core/tests/proxy.test.ts › a search finds an item by its raw object or its proxy, from an index]`
- **An Array subclass**: a subclass of `Array` is searched through its proxy.
  `[test: packages/owl-core/tests/foreign_proxy.test.ts › includes / indexOf / lastIndexOf find an item by its proxy or its raw object, tracked]`

### observe() views

- **A late read**: a read through an `observe()` view between a change and its callback, later in the same `batch` or by an immediate reader the change ran first, is observed after the callback.
  `[test: packages/owl-core/tests/observe.test.ts › a read made in a batch after a notification is observed once the callback ran]`
  `[test: packages/owl-core/tests/observe.test.ts › a read an immediate effect makes before the callback runs is observed after it]`
- **The view holds a late read**: the view holds such a read from the read on, so it survives its last other reader stopping before the callback runs.
  `[test: packages/owl-core/tests/observe.test.ts › a late read whose last other reader is disposed before the callback is still observed]`
  `[test: packages/owl-core/tests/observe.test.ts › a late read whose last other reader stops reading it first is still observed]`
- **`forEach`**: `forEach` through a view hands out views.
  `[test: packages/owl-core/tests/observe.test.ts › forEach through a map view hands out views, and the view as the map]`
- **Length-changing writes**: a `push` or `splice` through a view reads the length through the view and calls its callback.
  `[test: packages/owl-core/tests/observe.test.ts › a push into an observed empty array calls the callback (Odoo website's ResourceEditor errors)]`
  `[test: packages/owl-core/tests/observe.test.ts › a write that shifts an array through the view calls the callback, as OWL 2's reactive() did]`
- **Collection iterators**: collection iterators through a view preserve array members' identity, yield live views and support iterator helpers.
  `[test: packages/owl-core/tests/collection_contract.test.ts › Set %s keeps array members as live views]`
  `[test: packages/owl-core/tests/collection_contract.test.ts › Map %s keeps arrays as live views]`
  `[test: packages/owl-core/tests/collection_contract.test.ts › iterator helpers keep observing each consumed value]`

## Validation

### Schemas

- **A constructor is not a type**: a constructor in a type schema (`{ a: String }`) throws instead of accepting everything.
  `[test: packages/owl-core/tests/validation.test.ts › a constructor or a non-function in a shape is rejected, not silently accepted]`
- **At the top level too**: a top-level schema is checked as a nested one is, by `validateType` and by a registry's `validation`.
  `[test: packages/owl-core/tests/validation.test.ts › a top-level schema is checked as a schema nested in a shape is]`
- **An optional custom validator**: a `customValidator` of an optional type is optional, and carries that type's default.
  `[test: packages/owl-core/tests/validation.test.ts › a customValidator wrapping an optional type may be omitted, and is not called on undefined]`
  `[test: packages/owl-core/tests/validation.test.ts › a customValidator wrapping a defaulted type carries the default]`
- **`t.ref()` without a DOM**: `t.ref()` can be declared without a DOM; only checking a non-null value needs one.
  `[test: packages/owl-core/tests/validation.test.ts › t.ref() is a schema without a DOM, and its validation needs one]`

### Defaults

- **Plain data is filled**: `applyDefaults` fills plain data: an object of `null` prototype, an object whose prototype has a `null` prototype (`Object.prototype` of any realm, which is recognized that way), or a plain array.
  `[test: packages/owl-core/tests/validation.test.ts › leaves an instance of a class as it is, its kind kept]`
- **Anything else is returned as it is**: an instance of a class (an `Array` subclass, an object with private members), or any object further down a prototype chain, is returned as it is, not copied into a plain object.
  `[test: packages/owl-core/tests/validation.test.ts › leaves an instance of a class as it is, its kind kept]`

### Schema types

- **A schema is not its value**: a schema is typed as a schema, not as the value it describes, so `t.number().toFixed()` and `const s: string = t.string()` do not compile.
  `[test: packages/owl-core/tests/specification.test.ts › a schema is typed as a schema, not as the value it describes]`
- **No phantom brand**: `Schema<T>` carries `T` under a module-private brand, so the published declarations declare no value the build does not export.
  `[test: packages/owl/tests/types_build.test.ts › %s exports every value %s declares, and declares every value it exports]`
- **Schemas of entries**: `Registry` and `Resource` take a `Schema<V>` as `validation`, their entries typed `V`, and `useConfig` takes a `Schema<T>`.
  `[test: packages/owl-core/tests/specification.test.ts › a registry or resource validation is a schema of its entries, and useConfig takes a schema]`
- **`registry.get` with a default**: `registry.get(key, d)` is typed `V | D`.
  `[test: packages/owl-core/tests/specification.test.ts › registry.get with a default is typed as the entry or the default]`
- **`useListener` targets**: `useListener` takes an event target or any function reading one.
  `[test: packages/owl-core/tests/specification.test.ts › useListener takes an event target or any function reading one]`
- **`this.constructor`**: a component's `this.constructor` is typed as its class, so `useProps(this.constructor.props)` type-checks.
  `[test: packages/owl/tests/types_build.test.ts › a consumer reads a component's static props through this.constructor, as useProps(this.constructor.props) does]`

## Plugins

- **A dependency cycle**: a plugin dependency cycle through constructors or field initializers throws `Circular plugin dependency: <path>` instead of overflowing the stack.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a dependency cycle between field initializers throws instead of overflowing]`
  `[test: packages/owl-runtime/tests/plugins.test.ts › a cycle through a setup reports its whole path]`
- **Asking for each other in `setup()`**: plugins asking for each other in `setup()` each get the other, which is logged on the `plugin` channel.
  `[test: packages/owl-runtime/tests/plugins.test.ts › plugins asking for each other in their setups each get the other]`
  `[test: packages/owl-runtime/tests/plugins.test.ts › a cycle, and a handout mid-setup, are logged on the plugin channel]`
- **A synchronous start failure**: it leaves no later batch pending.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a later batch is no longer pending once the first batch failed synchronously]`
- **A plugin without a declared id**: a plugin without a declared `static id` is found only for its own class: `getPlugin` and `usePlugin` check `instanceof`, and look past another class of that name to the parent managers.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a plugin without a declared id is not handed out for another class of that name]`
- **A declared id**: a plugin with a declared `static id` shadows a parent manager's plugin of that id.
  `[test: packages/owl-runtime/tests/plugins.test.ts › plugin can be shadowed]`
- **A dependency with its dependent's id**: a dependency started implicitly with its dependent's id throws the duplicate-id error instead of being overwritten.
  `[test: packages/owl-runtime/tests/plugins.test.ts › plugin depending on another plugin with the same id (start only A, B is started implicitly)]`
- **Nested starts**: plugins started from a plugin's `setup()` hold the batch that started it, so neither `ready` nor the manager's status gets ahead of them.
  `[test: packages/owl-runtime/tests/plugins.test.ts › plugins started from a plugin's setup are waited for]`
  `[test: packages/owl-runtime/tests/plugins.test.ts › a plugin's own onWillStart after a nested start does not let ready skip the nested one]`
- **A parent's pending plugin**: a plugin of a child manager asking for one its parent has pending throws `not started yet` instead of starting a copy, unless the child lists it.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a child manager's plugin does not start its own copy of a plugin its parent has pending]`
  `[test: packages/owl-runtime/tests/plugins.test.ts › a child manager starts a plugin it lists itself, though its parent has that plugin pending]`
- **Deferred behind a pending start**: a plugin deferred behind a pending start is pending too.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a plugin deferred behind a pending start is reported as not started yet]`
- **A rejected start**: a rejected start does not block later ones.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a rejected start does not hold back later starts]`
- **Nothing to start**: an empty plugin list or resource leaves the manager ready.
  `[test: packages/owl-runtime/tests/plugins.test.ts › an empty plugin list leaves the manager ready, as no list does]`
- **A resource-driven start**: a start driven by a resource belongs to its manager, not to the effect it was called in.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a resource-driven start made inside an effect outlives that effect's run]`
  `[test: packages/owl-core/tests/ownership.test.ts › a plugin started from a resource's effect keeps its effects when that effect re-runs]`
- **`startPlugin`**: starting a plugin runs in its manager's scope, untracked, and a destroyed manager refuses it.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a plugin started directly runs in its manager's scope]`
  `[test: packages/owl-runtime/tests/plugins.test.ts › starting plugins from an effect does not subscribe it to what they read]`
  `[test: packages/owl-runtime/tests/plugins.test.ts › a destroyed manager starts no plugin]`
- **Teardown order**: plugins are torn down before the plugins they use: each plugin's destroy callbacks are one group, registered when its start ends, and groups run in reverse order of completion.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a plugin is torn down before the plugins it uses, whenever it asked for them]`
- **Config keys**: `useConfig` ignores `Object.prototype` members.
  `[test: packages/owl-runtime/tests/plugins.test.ts › a config key named like an Object.prototype member is unset]`
- **A failed App constructor**: an App whose constructor fails while starting plugins destroys the plugins started before and unregisters itself.
  `[test: packages/owl-runtime/tests/app/startup_cleanup.test.ts › failed synchronous plugin startup unregisters the app and releases earlier plugins]`

## Registries

- **A forced `use()`**: a `registry.use()` with `{ force: true }` restores the entry it overwrote when it ends.
  `[test: packages/owl-core/tests/registry.test.ts › with { force: true } overwrites an existing key]`
  `[test: packages/owl-core/tests/registry.test.ts › overrides stacked with { force: true } restore the nearest one still in use]`

## Rendering

### Component identity

- **A dynamic `t-component` is keyed by its class**: a dynamic `t-component` keys its child by an id of the class, not its name, so two classes with the same name are two components.
  `[test: packages/owl-runtime/tests/components/t_component.test.ts › the other class, once its pending render resolves, is a new instance of it in place of the mounted one]`
- **Committed children only**: `__owl__.children` lists committed children only; a component a pending render creates appears once that render is committed.
  `[test: packages/owl-runtime/tests/components/t_component.test.ts › the other class, once its pending render resolves, is a new instance of it in place of the mounted one]`
  `[test: packages/owl-runtime/tests/components/t_component.test.ts › destroying the app while the other class's render is pending destroys both]`

### Hook rejections

- **A stale rejection is dropped**: a rejected `onWillStart` or `onWillUpdateProps` of a render a newer one replaced, or of a removed component, is dropped: no handler sees it and the app keeps rendering.
  `[test: packages/owl-runtime/tests/components/concurrency.test.ts › a rejection of a superseded onWillUpdateProps is dropped, the newer update applies]`
  `[test: packages/owl-runtime/tests/components/error_handling.test.ts › an onWillStart rejecting after its component was removed leaves the app and the ancestors alone]`
  `[test: packages/owl-runtime/tests/components/error_handling.test.ts › an onWillUpdateProps rejecting after its component was removed leaves the app and the ancestors alone]`
- **Logged**: the dropped rejection is logged on the `error` channel.
  `[test: packages/owl-runtime/tests/specification.test.ts › a rejection of a superseded onWillUpdateProps is logged on the error channel]`
- **A synchronous throw in `onWillUpdateProps`**: it is handled as a rejection is, by the component's own `onError` first.
  `[test: packages/owl-runtime/tests/components/error_handling.test.ts › sync error in onWillUpdateProps is caught by child's own onError, as an async one]`
- **Props validation still fails the parent**: an invalid prop still fails the parent's render after an `onWillUpdateProps` that throws.
  `[test: packages/owl-runtime/tests/components/error_handling.test.ts › an invalid prop after an onWillUpdateProps that throws leaves no unhandled rejection]`

### A failed render pass

- **Other components keep rendering**: after a render pass fails and its error is handled without a re-render, its other mounted components keep rendering on their own, a render one asks for while its `onWillUpdateProps` waits included.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › a sibling updated in that pass still renders on its own]`
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › a render it asks for while its onWillUpdateProps waits, %s the pass failed, renders on its own]`
- **A component the pass created waits**: a component the failed pass created waits for the pass instead of committing alone.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › a component the pass created, never mounted, waits for the pass instead of committing alone]`
- **A commit is never committed again**: a component a failed commit already patched or mounted gets its `onPatched` or `onMounted` from the next commit of it or of a component below it, and no `onPatched` before the `onMounted` it is owed.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › an onMounted owed since a failed commit runs once when a descendant's commit pays it first]`
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › after an onPatched error handled without a re-render, a later commit below runs the owed onPatched]`
- **`onWillUnmount` after `onMounted`**: such a component gets `onWillUnmount` once it got `onMounted`.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › ancestors mounted by the recovery of a failed first mount keep their onWillUnmount]`

### A first mount that throws

- **It removes what it inserted**: a first mount that throws half way removes the nodes it inserted and unsets the refs it set.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › leaves none of the nodes it inserted in the target]`
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › unsets a ref it set before the throw]`
- **Its children go back to unmounted**: the children it mounted go back to unmounted, and no `onWillUnmount` runs for them.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › runs no onWillUnmount of the children it rolled back, and one that would throw does not stop it]`
- **Recovery mounts afresh**: the error is handled first, then the recovery destroys those children and mounts afresh instead of patching a half-mounted tree.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › is mounted afresh by the recovery, its children set up again]`
- **Nothing handling it**: with no handler, `mount()` rejects with that error.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › rejects with its own error when nothing handles it, though a child's onWillDestroy throws]`

### Removal errors

- **During a patch**: an `onWillUnmount` that throws during a patch does not abort it; the error is handled, from the removed component, once the patch is done.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › an onWillUnmount error does not stop the patch removing its component]`
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › an onWillUnmount error of a patch is reported before the onMounted of what it mounted]`
- **Outside a patch**: a removal outside any patch (`blockDom.remove`) throws it.
  `[test: packages/owl-runtime/tests/components/error_recovery.test.ts › a removal error outside any patch is thrown by the removal]`

### Suspense, Portal and ErrorBoundary

- **A Suspense's content belongs to its DOM**: it moves with the Suspense in a list.
  `[test: packages/owl-runtime/tests/components/suspense.test.ts › moves with its Suspense when a list is reordered]`
- **Under a shadow root**: a Suspense works at the top level of a component mounted in a shadow root.
  `[test: packages/owl-runtime/tests/components/suspense.test.ts › is shown at the top level of a component mounted in a shadow root]`
- **An unhandled error under a Suspense or a Portal**: it destroys the app once, like any other.
  `[test: packages/owl-runtime/tests/components/suspense.test.ts › an error nobody handles under Suspense destroys the app, reported as not handled]`
  `[test: packages/owl-runtime/tests/specification.test.ts › an error nobody handles under a Portal destroys the app once]`
- **An error of the fallback**: an `ErrorBoundary` passes an error caught while its fallback shows to its parent.
  `[test: packages/owl-runtime/tests/components/error_boundary.test.ts › an error of the fallback goes to the boundary's parent, rendered once]`

### mount() and deep renders

- **A failed `mount()`**: `mount()` destroys the App it created when the mount fails.
  `[test: packages/owl-runtime/tests/app/app.test.ts › a failed mount leaves no app behind]`
- **An App destroyed first**: `mount()` rejects with an `AbortError` when its App is destroyed before the mount ends.
  `[test: packages/owl-runtime/tests/plugins.test.ts › mount() rejects with an AbortError when its app dies while plugins start]`
  `[test: packages/owl-runtime/tests/plugins.test.ts › mount() rejects with an AbortError when its app dies while the root's onWillStart waits]`
- **`render(true)`**: a deep render renders every `t-memo` item again, and the content of a Portal or a Suspense too.
  `[test: packages/owl-runtime/tests/components/t_memo.test.ts › a deep render renders the children of a memoized item again]`
  `[test: packages/owl-runtime/tests/components/portal.test.ts › a deep render renders the components of its content again]`
  `[test: packages/owl-runtime/tests/components/suspense.test.ts › a deep render renders the components of its content again]`

## Events and blockdom

### Bound properties

- **A bound property is given as its value**: a bound property (`t-att-value`, `t-attf-value`, `t-att-checked`, `disabled`, `readOnly`, `selected`, `indeterminate`) is given to its block as its value, with no wrapper object.
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › a bound property makes no wrapper object]`
- **A value is written on every patch**: `value` is written on every patch, even when the element already holds it.
  `[test: packages/owl-runtime/tests/blockdom/block_properties.test.ts › a synced value is written on every patch, even when the element already reads it]`
  `[test: packages/owl-runtime/tests/blockdom/block_properties.test.ts › a synced value the user changed is set back by a patch giving the same value]`
- **A flag only when it differs**: `disabled`, `readOnly`, `checked`, `selected` and `indeterminate` are written only when the element holds another value.
  `[test: packages/owl-runtime/tests/blockdom/block_properties.test.ts › a synced flag already holding its value is not written again]`
  `[test: packages/owl-runtime/tests/blockdom/block_properties.test.ts › a synced flag the user changed is set back by a patch giving the same value]`
- **`t-model`**: `t-model`'s property is set only when the model changes.
  `[test: packages/owl-runtime/tests/blockdom/block_properties.test.ts › a (t-model) property is written only when its value changes]`
- **`value` last**: a `value` property (`t-att-value`, `t-model`) is set after the element's other attributes and its children, so a select finds its `t-foreach` options and a range input its `max`.
  `[test: packages/owl-runtime/tests/blockdom/block_properties.test.ts › a select's value is set once the options a child mounts exist]`
  `[test: packages/owl-runtime/tests/blockdom/block_properties.test.ts › an input's value is set after the attributes bounding it]`

### Class, style and t-att objects

- **Applied at every patch**: a `class`, `style` or `t-att` object is applied at every patch, diffed against a normalized copy of what its slot last wrote, so one changed in place shows.
  `[test: packages/owl-runtime/tests/blockdom/block_attributes.test.ts › a class object changed in place is applied again]`
  `[test: packages/owl-runtime/tests/blockdom/block_attributes.test.ts › a class array changed in place is applied again]`
  `[test: packages/owl-runtime/tests/blockdom/block_attributes.test.ts › a style object changed in place is applied again]`
  `[test: packages/owl-runtime/tests/blockdom/block_attributes.test.ts › a t-att object changed in place is applied again]`
- **An equal string is skipped**: a class string equal to the last one is not written again.
  `[test: packages/owl-runtime/tests/specification.test.ts › a class string equal to the last one is not written again]`
- **A truthy class**: a class whose value is truthy but not `true` is not written again.
  `[test: packages/owl-runtime/tests/blockdom/block_attributes.test.ts › an unchanged class whose value is truthy but not true is not written again]`
- **No repair**: Owl never repairs a class, style or attribute changed by other code: it writes what differs from its own last write, so a class removed by other code stays removed while its value stays truthy.
  `[test: packages/owl-runtime/tests/blockdom/block_attributes.test.ts › a class, style or attribute changed by other code is not repaired]`
- **A proxied class or style object is read during the render**: a proxied class or style object (`t-att-class`, `t-att-style`, in a class array, or the `class` / `style` of a `t-att` object) has its keys and values read during the render, so a change made to it in place renders the component again.
  `[test: packages/owl-runtime/tests/components/style_class.test.ts › a proxied class or style object changed in place re-renders on its own]`
  `[test: packages/owl-runtime/tests/components/style_class.test.ts › a proxied class object in a class array or a t-att object re-renders on its own]`
- **A `t-att` of a string or a number**: a `t-att` given a string (a `Markup` included) or a number throws an OwlError.
  `[test: packages/owl-runtime/tests/blockdom/block_attributes.test.ts › t-att given a string or a number is an error naming it]`
  `[test: packages/owl-runtime/tests/blockdom/block_attributes.test.ts › t-att given a string object is an error]`

### Blocks and handlers

- **One block type per block string**: a block string has one block type, given its handlers at each call (`type(data, children, handlers)`); `createBlock(str, list)` checks the list, and a missing list throws at mount.
  `[test: packages/owl-runtime/tests/blockdom/block_event_handling.test.ts › a block string has one block type, given its handlers at each call]`
- **No block type per handler site**: making an App's template functions makes no block type per block with handlers.
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › making a template's functions makes no block type per block with handlers]`
- **A handler's code is static**: a render gives a handler only its context and allocates no handler array.
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › an event handler makes no array: its code is static, its data the context]`
- **The main event handler**: `config.mainEventHandler` is called once per handler; a synthetic catcher runs its dispatch itself, not through it.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › a synthetic catcher calls the main event handler once per handler, not for its own dispatch]`
- **A mounted block as text**: a mounted block's `toString()` is its element's markup, and the block keeps patching that element.
  `[test: packages/owl-runtime/tests/blockdom/block.test.ts › a mounted block stringifies its own element and keeps patching it]`
- **A malformed block string**: a block string blockdom cannot build throws an OwlError.
  `[test: packages/owl-runtime/tests/blockdom/block.test.ts › a block string blockdom cannot build is an error, not content]`

### Child keys

- **A child's key is exact**: site ids, loop keys, `t-key`s and slot and template names are segments of a child's key, so no value of any type or content spells another child's key.
  `[test: packages/owl-runtime/tests/components/component_keys.test.ts › nested loops whose string keys hold the separator of their site ids]`
  `[test: packages/owl-runtime/tests/components/component_keys.test.ts › nested loops whose string keys hold the mark of a segment]`
  `[test: packages/owl-runtime/tests/components/component_keys.test.ts › random templates with adversarial loop keys give every child a key of its own]`
- **A loop key carries its type**: `1` and `"1"` are two keys.
  `[test: packages/owl-runtime/tests/components/component_keys.test.ts › a value's key carries its type]`
- **An array key is compared by its items**: an array used as a key is the same key as another array of the same items.
  `[test: packages/owl-runtime/tests/components/component_keys.test.ts › arrays of objects as keys are told apart by their items]`
  `[test: packages/owl-runtime/tests/components/t_foreach.test.ts › an array key keeps its item's component and element across renders]`
- **A slot's default content**: a slot's default content has its own key segment, so it never shares a component with the slot's content.
  `[test: packages/owl-runtime/tests/components/component_keys.test.ts › a slot's content and its default content never share a component]`
- **A list item is diffed by that key**: an array or `NaN` key keeps its item, its `t-memo` entry and the dev duplicate check.
  `[test: packages/owl-runtime/tests/blockdom/list.test.ts › a NaN key matched through the key map is not used as an anchor again]`
  `[test: packages/owl-runtime/tests/components/t_memo.test.ts › an item keyed by an array keeps its previous content]`
  `[test: packages/owl-runtime/tests/components/t_foreach.test.ts › crash on two arrays of the same items used as keys in dev mode]`
- **A `t-key` keys every component under it**: through a `t-if`, several children or a nested `t-key`.
  `[test: packages/owl-runtime/tests/components/t_key.test.ts › a t-key on a <t> holding a t-if recreates the component inside when the key changes]`
  `[test: packages/owl-runtime/tests/components/t_key.test.ts › a t-key on a <t> holding several components recreates each of them when the key changes]`
  `[test: packages/owl-runtime/tests/components/t_key.test.ts › nested t-keys: a change of the outer one recreates the component inside]`
- **Symbol keys**: symbols are valid `t-key`s, told apart by identity.
  `[test: packages/owl-runtime/tests/components/t_key.test.ts › symbol keys are told apart by identity]`
- **A dynamic `t-call` in a loop**: a dynamic `t-call` key cannot collide across loop items.
  `[test: packages/owl-runtime/tests/components/t_call.test.ts › a dynamic t-call in a loop keeps the components of two items apart]`

### t-set bodies output elsewhere

- **Rendered in the component that outputs it**: a `t-set` body output by another component renders in that component: its components are that component's children.
  `[test: packages/owl-runtime/tests/components/component_keys.test.ts › a t-set body output by another component renders with it]`
  `[test: packages/owl-runtime/tests/components/component_keys.test.ts › a t-set body output by two components gives each its own components]`
- **Given to an attribute**: a `t-set` body given to an attribute, interpolation, property or `t-att` is its string taken during the render, so the attribute follows what the body reads.
  `[test: packages/owl-runtime/tests/components/t_set.test.ts › read only in an attribute: the render follows what the body reads]`
  `[test: packages/owl-runtime/tests/components/t_set.test.ts › in t-att, as an object's value or a pair's]`
- **`String()` of a body holding a component**: it throws, since it would create the component and never mount it.
  `[test: packages/owl-runtime/tests/compiler/t_set.test.ts › a t-set body holding a component cannot be stringified]`
- **`String()` of other bodies**: a text node stringifies to its text, and a bigint to its digits, `0n` included.
  `[test: packages/owl-runtime/tests/specification.test.ts › String() of a t-set body gives a text node's text and a bigint's digits]`
  `[test: packages/owl-runtime/tests/blockdom/text.test.ts › a text node stringifies to its text, and renders it as text again]`

### Component and slot handlers

- **Looked up at the first dispatch**: a `t-on` on a component or slot mounted by its component's own render looks up the handler enclosing it at its first dispatch, not mid-patch, and logs it on the `event` channel.
  `[test: packages/owl-runtime/tests/components/t_on.test.ts › a slot's t-on mounted by its component's own render runs, then the t-on on the component]`
  `[test: packages/owl-runtime/tests/specification.test.ts › a slot's t-on mounted by its component's own render finds the enclosing handler at its first dispatch, logged on the event channel]`
- **One listener per kind**: every component `t-on` on a parent element shares one listener per kind (event name, capture, synthetic), kept on no property of the parent.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › one catcher site over many parents adds one listener function and no per-parent names]`
- **Passive only when all are**: that listener is passive only while every handler of its kind on that parent is; a passive handler's `preventDefault` is ignored otherwise.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › a passive inner one and a non-passive outer one share one dispatch]`
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › a passive registration does not make a later one passive]`
- **Nested order**: the catchers run as nested elements would, whatever site or render made each: a nested component's handler before the enclosing one's as the event bubbles, the enclosing one's first for `.capture`.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › a catcher of another site nested in one runs before it, whichever site listened first]`
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › capture handlers run outermost first, and a stop there stops the inner one]`
- **Stops**: a stop in one catcher skips the ones around it, and `stopImmediatePropagation()` every other.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › a .stop on the inner one stops the outer one]`
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › stopImmediatePropagation in the inner one stops every other]`
- **Native listeners of the parent**: a native listener on that parent runs before or after all the catchers, not between; the parent's own native `t-on`s run before them in both phases, and a stop on either side does not skip the other.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › an event stopped before the catchers' listener still reaches them all]`
  `[test: packages/owl-runtime/tests/components/t_on.test.ts › a t-on on a component and one on its parent element: synthetic ones nest, native ones do not]`
- **`.self` on a component**: `t-on-*.self` on a component means the event targets one of its root elements.
  `[test: packages/owl-runtime/tests/components/t_on.test.ts › t-on.self on a component runs for an event targeting one of its root nodes]`
- **`.passive` with `.prevent`**: it throws when the template compiles.
  `[test: packages/owl-runtime/tests/compiler/event_handling.test.ts › t-on crashes when a passive handler prevents the default]`
  `[test: packages/owl-core/tests/event_modifiers.test.ts › a passive key that prevents the default throws]`
- **One modifier mask**: the modifier mask also carries `.capture`, `.passive` and `.synthetic`.
  `[test: packages/owl-core/tests/event_modifiers.test.ts › capture, passive and synthetic choose the listener, outside the handler modifiers]`

### Synthetic handlers

- **Other roots**: synthetic (`.synthetic`) handlers also listen on the shadow root or other document an app is mounted in.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › inside an open shadow root]`
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › a shadow root of an iframe's document is a root too]`
- **A root is found by a mount into it**: a target mounted detached and moved into a shadow root later is not listened on there, so of the events inside it only the composed ones reach its synthetic handlers.
  `[test: packages/owl-runtime/tests/specification.test.ts › a target mounted detached and moved into a shadow root later gets only the composed events there]`
- **Each root replays its own nodes**: each root replays only the nodes of its own tree, with the target a native listener there would see.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › a composed event from a shadow root: each root replays its own nodes]`
- **Capture in a shadow root**: capture handlers inside a shadow root, closed ones included, run for composed events.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › a capture handler in a closed shadow root runs for a composed event]`
- **One pass**: the handlers of one event and phase, passive or not, are replayed in one pass, in path order, up to a stop; a passive one cannot prevent the default.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › passive and other handlers of an event are replayed in one pass, in path order]`
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › a passive handler cannot prevent the default when the listener is not passive]`
- **Component handlers as a level**: on one element, the synthetic `t-on`s of components among its children run as a level inside the element's own: before them as the event bubbles, after them for `.capture`, and a stop in one level skips the other.
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › the component's runs first as the event bubbles, and its stop keeps the element's out]`
  `[test: packages/owl-runtime/tests/blockdom/event_catcher.test.ts › the element's runs first with .capture, and its stop keeps the component's out]`
- **A collected root**: a root that was garbage-collected is dropped, and with none left the events of the document skip the per-root replay again.
  `[test: packages/owl-runtime/tests/blockdom/synthetic_roots.test.ts › a collected shadow root no longer sends the synthetic events of the others on the slow path]`

### Lists

- **Emptied at once only when alone**: a list empties its parent at once only when its items, one node each, and its anchor are all the parent holds; otherwise it removes them one by one.
  `[test: packages/owl-runtime/tests/blockdom/list.test.ts › of %s items, one node each, alone in its parent, empties it at once]`
  `[test: packages/owl-runtime/tests/blockdom/list.test.ts › of items of several nodes, or among other nodes, removes them one by one]`
- **Foreign nodes survive**: what a Portal or a widget put before, after or among the items survives either way.
  `[test: packages/owl-runtime/tests/blockdom/list.test.ts › an only child emptied keeps the nodes its parent got from elsewhere]`
  `[test: packages/owl-runtime/tests/blockdom/list.test.ts › an only child emptied keeps a node put between its items]`

### Namespaces

- **An explicit `xmlns`**: an explicit `xmlns` inside a namespaced block is its element's namespace.
  `[test: packages/owl-runtime/tests/blockdom/namespace.test.ts › an explicit xmlns inside a namespaced element is its namespace]`
  `[test: packages/owl-runtime/tests/compiler/svg.test.ts › an element given the xhtml namespace in an svg is an html element]`
- **A prefixed dynamic attribute**: a prefixed dynamic attribute (`xlink:`, `xml:`, or a prefix in scope in the block string), a `t-att` name included, is set and removed in its namespace, as a static one is.
  `[test: packages/owl-runtime/tests/blockdom/namespace.test.ts › a prefixed dynamic attribute is set and removed in its namespace]`
  `[test: packages/owl-runtime/tests/compiler/svg.test.ts › a prefixed t-att name is set and removed in its namespace]`
- **A prefixed attribute in the block string**: a prefixed attribute (`xml:lang`, `xlink:href`, `xmlns:xlink`, or a prefix the template declares) is given its namespace in the block string, so it keeps it in a block of its own.
  `[test: packages/owl-runtime/tests/compiler/svg.test.ts › prefixed attributes keep their namespace]`
  `[test: packages/owl-runtime/tests/compiler/svg.test.ts › a prefixed attribute in a block of its own keeps its namespace]`
  `[test: packages/owl-runtime/tests/compiler/svg.test.ts › an attribute of a prefix the template declares keeps its namespace]`
- **`t-tag` names**: `t-tag` rejects prefixed and `block-` names.
  `[test: packages/owl-runtime/tests/compiler/t_tag.test.ts › a tag name the block compiler would read otherwise is rejected]`

### Refs

- **Set once in the document, outermost first**: the ref callbacks of a mount run once its outermost block is inserted, a block's before those of the blocks inside it, each block's in document order.
  `[test: packages/owl-runtime/tests/blockdom/block_refs.test.ts › nested ref callbacks run once the outermost block is inserted, parents first]`
  `[test: packages/owl-runtime/tests/blockdom/block_refs.test.ts › the ref callbacks of one block run in document order]`
- **Removing a block releases the refs inside it**: a ref is cleared when owl removes its element, however deep.
  `[test: packages/owl-runtime/tests/components/refs.test.ts › a {set} ref inside a removed block's nested block is unset]`
  `[test: packages/owl-runtime/tests/components/refs.test.ts › set-like ref drops the elements of an enclosing block removed in bulk]`
- **Removed by other code**: an element removed by other code keeps its ref until owl removes it or binds the ref elsewhere.
  `[test: packages/owl-runtime/tests/components/refs.test.ts › an element removed by other code keeps its ref until owl removes it]`

## Templates

### Values at their place

- **Read where the template gives them**: an event handler, a slot's content, a `t-set` body and an arrow function given as a prop read the variables as they were where the template gives them, not as a later `t-set` or loop item left them.
  `[test: packages/owl-runtime/tests/compiler/t_set.test.ts › t-set after a dom element is executed, and a handler before it reads the value at the handler]`
  `[test: packages/owl-runtime/tests/components/props.test.ts › an arrow function prop reads the variables as they are where it is given, as a handler does]`
  `[test: packages/owl-runtime/tests/components/props.test.ts › an arrow function given to a called template or a slot reads the variables at its place]`
  `[test: packages/owl-runtime/tests/components/slots.test.ts › a variable set again after the component keeps its value at the component, whoever renders]`
  `[test: packages/owl-runtime/tests/components/slots.test.ts › a loop item's slot keeps the value an outer variable had at its item]`
- **One copy where needed**: the context is copied only when a later `t-set` can write a variable that code reads, and handlers, arrow functions, slots, t-call bodies and `t-set` bodies with no `t-set` between them share one copy.
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › handlers and arrow props with no write between them share one context copy]`
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › a slot, a t-call body and a t-set body share the copy of the handlers beside them]`
- **A `t-set` body reads at its `t-set`**: a `t-set` body reads its variables at its `t-set`, not at its output.
  `[test: packages/owl-runtime/tests/compiler/t_set.test.ts › t-set body is evaluated immediately]`

### Scoping

- **A directive on a `t-set-slot`**: a directive on a `t-set-slot` node makes only its content conditional: the slot is always given, so the child's default content never shows and `props.slots.<name>` is always set.
  `[test: packages/owl-runtime/tests/specification.test.ts › a directive on a t-set-slot node makes only its content conditional: the slot is always given]`
- **QWeb scoping**: a `t-if` opens no scope; a loop item does, and writes a variable `t-set` earlier outside it in the same template.
  `[test: packages/owl-runtime/tests/components/t_set.test.ts › t-set outside modified in t-if]`
  `[test: packages/owl-runtime/tests/compiler/t_foreach.test.ts › t-foreach with loops and multiple t-set]`

### Replaced content

- **Another `t-set` body**: a `t-out` showing one `t-set` body, then another (the variable set again in a branch), replaces the content.
  `[test: packages/owl-runtime/tests/specification.test.ts › a t-out showing one t-set body, then another, replaces the content]`
- **A `t-call-block` of another kind**: a `t-call-block`'s block of another constructor (a multi of another shape, a list of items of another kind) is mounted in place of the previous one.
  `[test: packages/owl-runtime/tests/components/t_call_block.test.ts › a block of another kind replaces the previous one]`
  `[test: packages/owl-runtime/tests/components/t_call_block.test.ts › a multi or a list of another shape replaces the previous one]`
- **A slot of another render function**: a slot output without default content is replaced when its render function changes (a forwarded slot that comes, goes or is swapped).
  `[test: packages/owl-runtime/tests/components/slots.test.ts › a forwarded slot that comes and goes replaces the empty content, and is replaced by it]`
  `[test: packages/owl-runtime/tests/components/slots.test.ts › a forwarded slot replaced by another slot of the same name replaces its content]`

### Rejected templates

- **A directive Owl would drop**: a `<t>` left bare takes no `t-*` attribute but a template root's `t-name`, `t-inherit`, `t-inherit-mode` and translation contexts, and a `t-set` none but `t-value`; anything else throws.
  `[test: packages/owl-compiler/tests/parser.test.ts › a <t> rejects a directive it would drop]`
  `[test: packages/owl-compiler/tests/parser.test.ts › a <t> keeps the attributes a template root carries]`
  `[test: packages/owl-compiler/tests/parser.test.ts › a t-set rejects a directive it would drop]`
- **`t-call-block` and `t-call-slot`**: they go on a `<t>`, and `t-call-block` takes no content.
  `[test: packages/owl-compiler/tests/parser.test.ts › t-call-block and t-call-slot go on a <t>, and t-call-block takes no content]`
- **A `t-set-slot`'s arguments**: they are the attributes no directive on it consumed.
  `[test: packages/owl-compiler/tests/parser.test.ts › a t-set-slot's arguments are the attributes no directive on it consumed]`
- **An empty expression**: a directive that needs an expression throws on an empty one, naming it, `t-tag` included, as do a `t-call`, `t-call-slot` or `t-slot` with an empty name.
  `[test: packages/owl-compiler/tests/parser.test.ts › an empty one is rejected with the directive's name]`
  `[test: packages/owl-compiler/tests/parser.test.ts › an empty name is rejected with the directive's name]`
- **Nested `t-set-slot`**: a `t-set-slot` nested directly in another throws.
  `[test: packages/owl-compiler/tests/parser.test.ts › a t-set-slot directly inside another one is rejected]`
- **`t-model.trim` on a checkbox**: it throws.
  `[test: packages/owl-compiler/tests/parser.test.ts › t-model.trim on a checkbox throws]`
- **Two prop suffixes**: a prop with two suffixes (`a.bind.translate`) throws `Invalid prop suffix`.
  `[test: packages/owl-runtime/tests/components/props.test.ts › throw if prop has more than one suffix]`

### Text and values

- **A blank `t-set` body**: a `t-set` with a `t-value` and a blank body takes the value.
  `[test: packages/owl-runtime/tests/compiler/t_set.test.ts › a t-set with a t-value and a blank body takes the value]`
- **CDATA**: a CDATA section is text, in an element or a `t-set` body.
  `[test: packages/owl-runtime/tests/compiler/simple_templates.test.ts › a CDATA section is text]`
- **`t-out="0"` with blanks**: `t-out="0"` with blanks around the `0` outputs the call's body.
  `[test: packages/owl-runtime/tests/compiler/t_call.test.ts › t-out of 0 with blanks around it outputs the call's body]`
- **`t-model.number`**: it checks the radio, or selects the static option, whose value equals the model's number.
  `[test: packages/owl-runtime/tests/components/t_model.test.ts › .number on radio inputs: the input of the model's number is checked]`
  `[test: packages/owl-runtime/tests/components/t_model.test.ts › .number on a select: a static option is selected by a number]`

### Compile errors

- **An invalid expression is named**: an invalid expression is named with why, and with the attribute and element holding it, whether the tokenizer or JavaScript rejects it, without the generated code.
  `[test: packages/owl-compiler/tests/compile_errors.test.ts › an invalid expression is named with its attribute and element, without the generated code]`
  `[test: packages/owl-compiler/tests/compile_errors.test.ts › %s names its attribute]`
  `[test: packages/owl-compiler/tests/compile_errors.test.ts › %s]`
- **The template is named**: every compile error of a named template names it, once, on its first line.
  `[test: packages/owl-compiler/tests/compile_errors.test.ts › every message of the corpus names its template once, on its first line]`
  `[test: packages/owl-compiler/tests/compile_errors.test.ts › a template error the parser throws names the template once]`
- **`this` is no template variable**: `this` is refused as a template variable, since expressions read it as the component.
  `[test: packages/owl-compiler/tests/compile_errors.test.ts › %s]`

### Expressions

- **Comments**: template expressions skip comments.
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › comments are skipped]`
- **Statements**: a statement keyword in an arrow's block body throws a named error.
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › a statement is rejected with the keyword it starts with]`
- **Object literal methods**: an object literal method, accessor or generator throws a named error.
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › an object literal method or accessor throws a named error]`
- **Function expressions**: a function expression with a name or parameters throws a named error.
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › a function expression with a name or parameters throws a named error]`
- **Spaces and properties of numbers**: `1 .toString()` keeps its space, and `.5.toFixed(1)` keeps its property.
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › an integer literal followed by a property access keeps its space]`
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › a numeric literal may start with its decimal point]`
- **`delete`**: `delete` is an operator, so `delete o.x` compiles.
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › a statement is rejected with the keyword it starts with]`
- **Interpolations**: `{{ }}` and `#{ }` end at the brace that closes them, past a regular expression after a division or a division after an object literal.
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › an interpolation ends at the brace that closes it, not at the first }}]`
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › a / after a division starts a regular expression, after a regular expression or an object it divides]`
- **An arrow prop's free variables**: they include those its parameter defaults read.
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › processExpr: an arrow's free variables include those its parameter defaults read]`
- **No accidental comments**: a division before a regular expression, and `<` before `!--`, compile apart instead of into a comment.
  `[test: packages/owl-compiler/tests/inline_expressions.test.ts › operators that would join into a comment stay apart]`

### Slots and contexts

- **Slots are not marked raw per render**: a slot read through a proxy is rendered from its raw object, and slots put in proxied state come back proxied, like any prop.
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › slots are given as they are, not marked raw on every render]`
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › slots held in proxied state and given with t-props]`
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › the template channel says a slot rendered from the raw object of a proxy]`
- **Nested loop items**: an item of a loop in a loop, and a t-call context in a loop, are made under the outer item's prototype with a copy of its loop names, unless a `t-set` writes that loop level or an expression assigns a context variable.
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › a nested loop's items and a call context copy the loop item's names, made under its prototype]`
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › a loop item a t-set writes is inherited from: a later write is seen by what reads it then]`
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › a template assigning a variable in an expression inherits from its loop items]`
- **The given context**: a slot without a slot scope and a t-call with neither attributes nor body render in the context they are given, not a child of it.
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › a slot without a slot scope renders in the context it was written in]`
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › a t-call with neither attributes nor body renders in the caller's context]`
- **No function per render**: a render makes no function for its slots, slot defaults, t-call bodies and t-out bodies.
  `[test: packages/owl-runtime/tests/components/render_allocations.test.ts › slots, slot defaults, t-call bodies and t-out bodies make no function per render]`
- **`t-props` spreads**: `t-props` copies with object spread, so an own `__proto__` key is a prop.
  `[test: packages/owl-runtime/tests/specification.test.ts › t-props copies with object spread: an own __proto__ key is a prop]`
- **t-call attributes are assigned**: a t-call attribute is assigned on the new context, so one named like a getter-only property up the context chain is ignored.
  `[test: packages/owl-runtime/tests/specification.test.ts › a t-call attribute named like a getter-only property up the context chain is ignored]`

### Build information

- **`__info__.hash`**: it is the commit, plus `-dirty-<digest>` when the sources differ from it; outside a git checkout, `nogit-<digest of the sources>`.
  `[test: packages/owl/tests/build_hash.test.ts › a clean checkout is named by its commit, a changed source makes it dirty]`
  `[test: packages/owl/tests/build_hash.test.ts › without a checkout, the sources are named by their digest]`
- **`__info__.date`**: it is `SOURCE_DATE_EPOCH` if set, whole seconds, anything else failing the build by name; else the commit's date for a clean build; else the build time.
  `[test: packages/owl/tests/build_hash.test.ts › SOURCE_DATE_EPOCH dates any build; a dirty or unversioned one is dated now]`
  `[test: packages/owl/tests/build_hash.test.ts › a malformed SOURCE_DATE_EPOCH is refused by name]`
  `[test: packages/owl/tests/build_hash.test.ts › a clean build is dated by its commit]`
