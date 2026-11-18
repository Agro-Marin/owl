# Behaviour specification

This page states the behaviour OWL guarantees for its reactivity and proxies, one rule per bullet, each naming the test that asserts it; `node tools/spec_check.mjs`, a verify step, fails any rule whose test is missing.
[The 3.0-marin fork page](fork_3.0-marin.md) stays as the history of where the fork differs from upstream.

## Reactivity

### Conformance

- **The cross-framework suite**: OWL passes every behavioural case of the cross-framework reactivity conformance suite, none of them an expected failure.
  [test: packages/owl-core/tests/conformance.test.ts › every behavioral case has a pinned verdict, and every pinned verdict a case]
  [test: packages/owl-core/tests/conformance.test.ts › no conformance case is an expected failure]

### Cycles

- **A computation reading itself**: a computation read while it runs throws `Cycle detected: <name> reads its own value` instead of recursing, after one run.
  [test: packages/owl-core/tests/computed.test.ts › a computed reading itself fails with a cycle error, after one run]
  [test: packages/owl-core/tests/computed.test.ts › two computeds reading each other fail with a cycle error]
- **Recovery**: a computed that catches its cycle error computes normally once it stops reading itself.
  [test: packages/owl-core/tests/computed.test.ts › a computed that caught its cycle error recovers once it stops reading itself]

### Bringing a computed up to date

- **A batch**: bringing a computed up to date is a batch: an `immediateEffect` or `observe()` callback that a write or a computed's change queues meanwhile runs once the outermost computed being evaluated is up to date (for a read, once the reader holds its value), never in the middle of an evaluation it could read.
  [test: packages/owl-core/tests/immediate_effect.test.ts › an immediate effect that put a computed out of date runs once it is recomputed, not inside it]
  [test: packages/owl-core/tests/immediate_effect.test.ts › an immediate effect reading back through a computed what its getter wrote runs once it is up to date]
  [test: packages/owl-core/tests/specification.test.ts › an observe() callback reading back through a computed what its getter wrote runs once it is up to date]
- **No cycle error**: an `immediateEffect` or `observe()` callback that reads back through a computed what its getter wrote, or that reads a computed which changed while another reader pulled it, gets the computed's up-to-date value, without a cycle error and without a re-entrant recompute.
  [test: packages/owl-core/tests/immediate_effect.test.ts › an immediate effect reading back through a computed what its getter wrote runs once it is up to date]
  [test: packages/owl-core/tests/specification.test.ts › an observe() callback reading back through a computed what its getter wrote runs once it is up to date]
  [test: packages/owl-core/tests/immediate_effect.test.ts › a reader keeps following a computed whose evaluation queued an immediate effect writing its source]
- **Its writes**: what such a callback writes reaches the computed's reader as any later write does, and the reader keeps following the computed.
  [test: packages/owl-core/tests/immediate_effect.test.ts › a reader keeps following a computed whose evaluation queued an immediate effect writing its source]
- **Owner before owned**: an owner whose sources are being checked does not run before the effect it owns.
  [test: packages/owl-core/tests/immediate_effect.test.ts › an owner whose sources are being checked does not run before the effect it owns]
- **Disposed during a check**: a computation disposed while its sources are checked stops checking them.
  [test: packages/owl-core/tests/immediate_effect.test.ts › an effect disposed while its sources are checked stops checking them]

### Ownership

- **An effect belongs to the run that creates it**: an effect created while a computation runs belongs to that computation, tracked or not: `untrack` keeps the owner.
  [test: packages/owl-core/tests/ownership.test.ts › created inside untrack is still the computed's]
  [test: packages/owl-core/tests/ownership.test.ts › by a getter read through an observe() view, inside untrack, belongs to the effect running]
- **An effect's effect**: an effect created by an effect's run is disposed before that effect runs again and when it is disposed.
  [test: packages/owl-core/tests/ownership.test.ts › within an effect is disposed when that effect re-runs and when it is disposed]
- **A computed's effect**: an effect created by a computed's getter, a detached computed's included, is disposed before the getter runs again and when the computed is disposed.
  [test: packages/owl-core/tests/ownership.test.ts › is disposed before the computed recomputes: N recomputes leave one, not N]
  [test: packages/owl-core/tests/ownership.test.ts › of a detached computed is disposed on recompute and when the flush disposes the computed]
- **A selector source's effect**: an effect created by a selector's source is disposed before the source runs again and when the selector stops following it.
  [test: packages/owl-core/tests/ownership.test.ts › an effect its source creates is disposed when the source runs again, and when no key is read]
- **An `observe()` callback's effect**: an effect created by an `observe()` callback is disposed before the callback runs again.
  [test: packages/owl-core/tests/specification.test.ts › an effect an observe() callback creates is disposed before the callback runs again]
- **A render's effect**: an effect created while a component renders belongs to the component and lasts until the component is destroyed.
  [test: packages/owl-runtime/tests/components/reactivity.test.ts › an effect its render creates inside untrack is the component's: disposed with it]
  [test: packages/owl-runtime/tests/components/reactivity.test.ts › an effect its render creates outlives the component's re-renders, until it is destroyed]
- **A scope is an ownership root**: an effect created while a scope is set up, even inside an effect's run, belongs to no computation.
  [test: packages/owl-core/tests/ownership.test.ts › an effect created in a scope's run inside an effect is not that effect's]
- **Detached effects**: `effect(fn, { detached: true })` creates an effect owned by nothing, which outlives the computation that created it.
  [test: packages/owl-core/tests/ownership.test.ts › with { detached: true } belongs to nothing: it outlives the effect that created it]
  [test: packages/owl-core/tests/effect.test.ts › creating A with { detached: true } escapes B's ownership]
- **Owner first**: when a computed and an effect it owns are both due after one change, the computed runs first, and the effect of its previous run is disposed instead of run again.
  [test: packages/owl-core/tests/ownership.test.ts › does not run again for a write its computed is recomputed for: the computed runs first]
  [test: packages/owl-core/tests/ownership.test.ts › an immediate one does not run again for a write its computed is recomputed for]
- **An owned `asyncComputed`**: an `asyncComputed` is disposed whole by its owner: it is no longer loading, and the result of its abandoned run is ignored.
  [test: packages/owl-core/tests/ownership.test.ts › created by an effect is disposed by its re-run: no longer loading, a late result is dropped]

### Disposal

- **An effect takes its computeds along**: disposing an effect disposes the computeds it was the last observer of, releasing their sources.
  [test: packages/owl-core/tests/computed.test.ts › an effect disposed unsubscribes the computed it was the last observer of]
  [test: packages/owl-core/tests/ownership.test.ts › is disposed with the computed its last observer's dispose cascades to]
- **A computed no run reads any more**: a re-run that stops reading a computed nothing else reads disposes it at the flush, a computed reading no source included.
  [test: packages/owl-core/tests/computed.test.ts › effect that stops reading a computed detaches it at the flush]
  [test: packages/owl-core/tests/ownership.test.ts › is disposed when the computed's last reader stops reading it]
- **Read again before the flush**: such a computed is kept when it is read again before the flush.
  [test: packages/owl-core/tests/computed.test.ts › computed re-observed before the flush is not disposed]
  [test: packages/owl-core/tests/computed.test.ts › a computed one reader stops reading and another reads in the same flush stays]
- **A change seen during a run**: an effect that saw a computed it read change during its run stays its observer, so another reader letting the computed go does not dispose it.
  [test: packages/owl-core/tests/computed.test.ts › an effect still follows a computed it saw change during its run when its other reader lets it go]
- **Read again after its disposal**: a disposed computed read again recomputes, returning a new object for an object result, and creates again the effects its getter creates, owned by it.
  [test: packages/owl-core/tests/specification.test.ts › a computed the flush disposed recomputes a new object when read again]
  [test: packages/owl-core/tests/ownership.test.ts › of a detached computed is disposed on recompute and when the flush disposes the computed]
- **`untrack` inside a viewed getter**: `untrack` inside a getter reached through an `observe()` view keeps that getter's reads of other proxies off the view.
  [test: packages/owl-core/tests/observe.test.ts › untrack keeps a getter's reads of other proxies off the view only inside the getter]
- **A view read subscribes the view in any context**: a read through an `observe()` view, `this` in a getter it reaches included, subscribes the view even inside `untrack` or a lifecycle hook, as does what such a getter reads outside an `untrack`.
  [test: packages/owl-core/tests/observe.test.ts › untrack keeps a getter's reads of other proxies off the view only inside the getter]
  [test: packages/owl-runtime/tests/components/reactivity.test.ts › an observe() view first read in onWillStart, or inside untrack, keeps calling back]

### Writes during a run

- **A getter that writes its source**: a computed whose getter writes a source it read ends out of date; its next read checks its sources and recomputes if one changed since the getter read it.
  [test: packages/owl-core/tests/computed.test.ts › a getter that writes a source it read ends out of date: the next read recomputes it]
- **An effect that writes a computed's source**: an effect that writes the source of a computed it read keeps the computed's value it read, as it keeps a signal's; it runs when a later write changes the computed from that value, not when the value comes back to it.
  [test: packages/owl-core/tests/effect.test.ts › an effect that resets a signal through a computed compares what it read, as it does for the signal]
  [test: packages/owl-core/tests/effect.test.ts › an effect that writes the source of a computed it read keeps tracking the computed]
- **Forwarding**: such a computed is not recomputed when the run ends; it forwards the next write to its readers.
  [test: packages/owl-core/tests/debug.test.ts › the reactivity and computed channels trace a write reaching a run that read it]
  [test: packages/owl-core/tests/effect.test.ts › a computed recomputed by a run invalidates a source that run read: it forwards the next write]
- **A write during a check**: a computation whose check (bringing its sources up to date to see whether one changed) ran a write to a source it had checked already ends up to date on what it checked, and that source forwards it its next write.
  [test: packages/owl-core/tests/computed.test.ts › an effect whose check ran a getter writing a source it checked already follows that source]
  [test: packages/owl-core/tests/immediate_effect.test.ts › an effect whose check ran an immediate effect writing a source it checked follows that source]

### Cleanup errors

- **On a recompute**: an owned effect's cleanup that throws when its computed recomputes is reported as an unhandled rejection, and the computed's readers still get the new value.
  [test: packages/owl-core/tests/ownership.test.ts › whose cleanup throws on a recompute: the error is reported, the readers get the new value]
- **On a cascade**: when a dispose cascades to computeds and a cleanup throws, the dispose throws after releasing everything, the disposed effect's own cleanup and children included.
  [test: packages/owl-core/tests/ownership.test.ts › whose cleanup throws when the computed is disposed by cascade: the dispose throws, after releasing everything]
  [test: packages/owl-core/tests/ownership.test.ts › whose cleanup throws when the reader's dispose cascades to it: the reader's own cleanup and effects are released]
- **In bulk**: when a scope or the flush disposes several computeds and a cleanup throws, every computed is disposed and the error goes to the scope's `reportError` or to the flush.
  [test: packages/owl-core/tests/ownership.test.ts › by their scope: the error is reported, every computed is disposed, the scope is destroyed]
  [test: packages/owl-core/tests/ownership.test.ts › by the flush, unobserved: every one is disposed, the error is reported]
- **A failed first run**: an effect whose first run throws is disposed; the run's error is thrown and an error of that dispose is reported.
  [test: packages/owl-core/tests/ownership.test.ts › whose cleanup throws when a reader's failed first run disposes it: the run's error is thrown, the cleanup's reported]

### Effects disposing themselves

- **From its cleanup**: an effect its own cleanup disposes does not run again.
  [test: packages/owl-core/tests/effect.test.ts › an effect its cleanup disposes does not run again]
- **From its run**: an effect its own run disposes keeps no subscription, also when the run then throws.
  [test: packages/owl-core/tests/effect.test.ts › an effect that disposes itself and then throws keeps no subscription]
  [test: packages/owl-core/tests/tracking.test.ts › an effect disposed by its own run releases what it reads after]
- **Not run again by its own run's write**: an effect its own run disposes is not run again by a write later in that run.
  [test: packages/owl-core/tests/effect.test.ts › an immediate effect that disposed itself is not run again by a write later in that run]
- **Errors of that dispose**: when such a run throws, the run's own error is thrown and an error dropping its sources or releasing it goes to `Promise.reject`.
  [test: packages/owl-core/tests/effect.test.ts › an effect that disposes itself and then throws keeps its error when dropping a source throws]
- **Cleanup functions only**: an effect keeps what its run returns as its cleanup only when it is a function.
  [test: packages/owl-core/tests/effect.test.ts › an effect keeps what it returns only when it is a cleanup function]

### Selectors

- **One batch per change**: a selector notifies the readers of the previous and of the new key in one batch, so an immediate reader of both runs once.
  [test: packages/owl-core/tests/selector.test.ts › an immediate reader of both keys of a change runs once]
- **A throwing reader**: a reader of one key that throws leaves the readers of the other key notified.
  [test: packages/owl-core/tests/selector.test.ts › a reader of the previous key that throws leaves the readers of the new key notified]
- **A failing source**: a selector rethrows its source's error for every key, and runs its readers again once the source recovers.
  [test: packages/owl-core/tests/selector_contracts.test.ts › a changed source failure notifies every key reader ($name)]
  [test: packages/owl-core/tests/selector.test.ts › a failing source is rethrown for every key, and its readers run again once it recovers]
- **Following its source**: a selector follows its source only while a computation reads one of its keys.
  [test: packages/owl-core/tests/selector.test.ts › a selector no computation reads any more stops following its source]

### Async computeds

- **Waiting for a queued run**: `currentPromise()` waits for a run that a dependency change or `refresh()` queued, not only for one in flight.
  [test: packages/owl-core/tests/async_computed.test.ts › currentPromise() right after a dependency changed waits for the run it queued]
  [test: packages/owl-core/tests/async_computed.test.ts › currentPromise() right after refresh() waits for the new run]
- **Disposal**: `dispose()` sets `loading()` to false.
  [test: packages/owl-core/tests/async_computed.test.ts › dispose() during a run leaves it not loading]
- **A fetcher throwing synchronously**: its run keeps its abort cleanup, so disposal, a re-run or the end of its scope aborts the work it started.
  [test: packages/owl-core/tests/async_computed_cleanup.test.ts › %s aborts a run whose fetcher threw synchronously]

### Scopes

- **Cleanup runs unsubscribed**: destroying or rolling back a scope runs its cleanup without subscribing the computation that asked for it.
  [test: packages/owl-core/tests/scope.test.ts › %s callbacks do not subscribe the computation requesting cleanup]
- **Cleanup runs unowned**: an effect a destroy callback creates during a destruction or a rollback does not belong to the computation that asked for it.
  [test: packages/owl-core/tests/specification.test.ts › an effect a destroy callback creates during %s is not the caller's]
- **Rollback drains**: a rollback also runs the destroy callbacks registered during its cleanup, and keeps those registered before its mark.
  [test: packages/owl-core/tests/scope.test.ts › rollback releases callbacks registered during cleanup, preserving earlier callbacks]

### Flush scheduling

- **Only when needed**: a write schedules the effects' flush only if it queues an effect or a computed's disposal that no scheduled flush will run, so a promise callback queued before a write that queues nothing new runs before the effects it queues.
  [test: packages/owl-core/tests/effect.test.ts › a write that queues nothing schedules no flush, whatever an earlier write queued]
  [test: packages/owl-core/tests/effect.test.ts › a write that queues again a disposal the flush will run schedules no flush]
- **After its immediate effects**: a write schedules the flush at its end, after its immediate effects, so a promise callback an immediate effect queues runs before the effects the same write queued.
  [test: packages/owl-core/tests/immediate_effect.test.ts › a microtask an immediate effect queues runs before the effects the same write queued]

### batched

- **Latest arguments**: `batched` calls its callback once per microtask, with the arguments of the latest call.
  [test: packages/owl-core/tests/utils.test.ts › calls the callback once per microtask, with the arguments of the latest call]

## Proxies

### Private members and markRaw

- **A private member reached through a proxy**: a getter or setter reaching a private member through a proxy throws an `OwlError` naming the member and the class to mark with `markRaw(<Class>.prototype)`, when a class of the proxied object declares that member.
  [test: packages/owl-core/tests/proxy.test.ts › a private member read through a getter throws an OwlError naming the key and markRaw]
  [test: packages/owl-core/tests/proxy.test.ts › a private member written through a setter throws the same OwlError]
- **Another class's private member**: a private member error that no class of the proxied object causes passes through unchanged.
  [test: packages/owl-core/tests/proxy.test.ts › a private member error the target's classes do not cause is rethrown as it is]
- **Built-in prototypes**: `markRaw` of a built-in prototype (`Object`, `Array`, `Map`, `Set`, `WeakMap`, `Function`) throws.
  [test: packages/owl-core/tests/proxy.test.ts › markRaw of a built-in prototype throws instead of leaving every such object unobserved]

### Writes

- **A setter write is one batch**: a write through a setter notifies every key it changes in one batch, so an immediate reader of several of them runs once, after it.
  [test: packages/owl-core/tests/proxy.test.ts › a setter writing its backing field runs an immediate reader once per write]
- **An array write is one batch**: an index or length write notifies in one batch, so an immediate reader of the index, the length and the items runs once.
  [test: packages/owl-core/tests/foreign_proxy.test.ts › an index write or a length write runs an immediate reader of the index, the length and the items once]
- **A delete is one batch**: a delete notifies the key, its presence and the key list in one batch.
  [test: packages/owl-core/tests/foreign_proxy.test.ts › a write, a creation or a delete runs an immediate reader of the key, its presence and the keys once]
- **The getter a setter write compares**: a write through a setter calls the key's getter, to compare the values, only when the key is observed.
  [test: packages/owl-core/tests/proxy.test.ts › a write through a setter calls its getter only when the key is observed]
- **A throwing getter there**: a getter that throws during that comparison counts as a change instead of failing the write.
  [test: packages/owl-core/tests/proxy.test.ts › a write through a setter whose getter throws until it was set succeeds, observed or not]
- **An index past the end**: an index written past the end of an array behind its own Proxy notifies its length, also through a shallow proxy.
  [test: packages/owl-core/tests/specification.test.ts › an index written past the end of an array behind its own Proxy notifies its length]
  [test: packages/owl-core/tests/foreign_proxy.test.ts › a shallow signal of it notifies an index written past the end once and hands out items as stored]

### Collections

- **No `add` on a Map**: a Map proxy and an `observe()` view of a Map have no `add`; it reads `undefined`, as on a Map.
  [test: packages/owl-core/tests/proxy.test.ts › a map proxy, or a view of one, has no add method, as a map has none]
- **A set operation's argument is checked natively**: a set operation (`union`, `intersection`, …) on a proxy rejects a non-set-like argument as the native method does.
  [test: packages/owl-core/tests/proxy.test.ts › a set operation rejects what is not set-like, as the native one does]
- **A set operation reads what the native one reads**: it reads of its argument only what the native method reads, its `has` or its `keys()`, lazily.
  [test: packages/owl-core/tests/proxy.test.ts › a set operation reads only what the native one reads of its argument]
  [test: packages/owl-core/tests/proxy.test.ts › a set operation reads a set-like through its keys iterator]
- **Raw comparison**: a set operation compares members by their raw objects.
  [test: packages/owl-runtime/tests/reactivity/proxy.test.ts › ES2025 set operations on deep reactive sets of objects compare raw members]
  [test: packages/owl-runtime/tests/reactivity/proxy.test.ts › a shallow set holding proxies compares its members with a deep set's by raw object]
- **A set operation's result**: it returns a plain Set of the members as their set holds them, the target's first.
  [test: packages/owl-core/tests/proxy.test.ts › a set operation answers as on the raw sets, each member as its set holds it, in order]
- **A mutation is one batch**: a `set`, `add`, `delete` or `clear` runs an immediate reader once after it, even when the reader reads several affected keys.
  [test: packages/owl-core/tests/collection_contract.test.ts › one Map mutation runs a reader of size, presence and value once]
  [test: packages/owl-core/tests/specification.test.ts › Set.add runs an immediate reader of the size and of the member once]
  [test: packages/owl-core/tests/collection_contract.test.ts › clear runs a reader of multiple entries once]
- **A throwing reader**: a collection mutation whose immediate reader throws still notifies the readers of the other keys.
  [test: packages/owl-core/tests/collection_contract.test.ts › a throwing immediate reader does not prevent other Map readers being notified]
- **Chained writes**: `set` and `add` return the reactive collection, so chained calls stay reactive.
  [test: packages/owl-core/tests/collection_contract.test.ts › Map.set returns its reactive collection and chained writes notify]
  [test: packages/owl-core/tests/collection_contract.test.ts › Set.add returns its reactive collection and chained writes notify]
  [test: packages/owl-core/tests/collection_contract.test.ts › WeakMap.set returns its reactive collection and chained writes notify]
- **Upserts**: `getOrInsert` and `getOrInsertComputed` on a `Map` or `WeakMap` read and notify their entry through the proxy, with the raw, deep and shallow value rules of `get` and `set`.
  [test: packages/owl-core/tests/collection_contract.test.ts › %s getOrInsert keeps reads, insertion and returned values reactive]
  [test: packages/owl-core/tests/collection_contract.test.ts › %s getOrInsertComputed normalizes the key and stored value and skips existing keys]
- **A collection's own properties**: a collection's own properties are read with the proxy as `this`, so a subclass getter is tracked.
  [test: packages/owl-core/tests/proxy.test.ts › a getter of a Map subclass reads the entries through the proxy]
- **Properties apart from entries**: a collection's own properties are observed apart from its entries.
  [test: packages/owl-core/tests/proxy.test.ts › a property of a collection and an entry of the same name are apart]

### Shallow proxies and raw storage

- **A shallow proxy keeps a proxy**: a shallow proxy (`signal.Array`, `signal.Object`) keeps a proxy written into it, as a shallow Map keeps a proxy value.
  [test: packages/owl-core/tests/proxy.test.ts › a shallow array and a shallow object keep the proxy written into them]
  [test: packages/owl-runtime/tests/reactivity/proxy.test.ts › a signal.Map hands back the proxy it was given, and tracks through it]
- **Raw members and keys**: a Set member and a Map key are stored raw by every kind of collection proxy.
  [test: packages/owl-core/tests/specification.test.ts › a %s collection stores a Set member and a Map key raw]
- **A collection already holding a proxy**: a collection that held a proxy before it was wrapped finds it, deletes it and notifies its readers through it.
  [test: packages/owl-core/tests/collection_contract.test.ts › a Set holding a proxy finds, deletes and notifies it]
  [test: packages/owl-core/tests/collection_contract.test.ts › a Map keyed by a proxy finds its entry, and its readers see writes to it]
  [test: packages/owl-core/tests/collection_contract.test.ts › clearing a Map keyed by a proxy notifies the readers of that key]

### Property introspection

- **`hasOwnProperty`**: `obj.hasOwnProperty(k)` through a proxy subscribes to the presence of `k`, as `in` does.
  [test: packages/owl-core/tests/proxy.test.ts › hasOwnProperty follows the presence of the key it asks about]
- **`Object.defineProperty`**: `Object.defineProperty` through a proxy defines on the target and notifies nothing.
  [test: packages/owl-core/tests/proxy.test.ts › Object.defineProperty through a proxy defines on the target and notifies nothing (Odoo web_studio's activeNode)]
- **Untracked introspection**: `Object.hasOwn`, `propertyIsEnumerable` and `Object.getOwnPropertyDescriptor` through a proxy subscribe to nothing.
  [test: packages/owl-core/tests/specification.test.ts › Object.hasOwn, propertyIsEnumerable and Object.getOwnPropertyDescriptor subscribe to nothing]

### Locked properties

- **Handed out as is**: a locked (non-configurable, non-writable) property is handed out as it is, by collections and `observe()` views too, as the Proxy invariant requires.
  [test: packages/owl-core/tests/proxy.test.ts › a locked property of a collection is raw]
  [test: packages/owl-core/tests/proxy.test.ts › an observe() view of a frozen object holding a proxy hands the proxy out]

### Array searches

- **One atom**: `includes`, `indexOf` and `lastIndexOf` on a proxied plain array subscribe to its items as one atom.
  [test: packages/owl-core/tests/proxy.test.ts › a search subscribes to the items as one atom, not to each index]
- **The raw array**: they search the raw array, so an item is found by its raw object or its proxy.
  [test: packages/owl-core/tests/proxy.test.ts › a search finds an item by its raw object or its proxy, from an index]
- **An Array subclass**: a subclass of `Array` is searched through its proxy.
  [test: packages/owl-core/tests/foreign_proxy.test.ts › includes / indexOf / lastIndexOf find an item by its proxy or its raw object, tracked]

### observe() views

- **A late read**: a read through an `observe()` view between a change and its callback, later in the same `batch` or by an immediate reader the change ran first, is observed after the callback.
  [test: packages/owl-core/tests/observe.test.ts › a read made in a batch after a notification is observed once the callback ran]
  [test: packages/owl-core/tests/observe.test.ts › a read an immediate effect makes before the callback runs is observed after it]
- **The view holds a late read**: the view holds such a read from the read on, so it survives its last other reader stopping before the callback runs.
  [test: packages/owl-core/tests/observe.test.ts › a late read whose last other reader is disposed before the callback is still observed]
  [test: packages/owl-core/tests/observe.test.ts › a late read whose last other reader stops reading it first is still observed]
- **`forEach`**: `forEach` through a view hands out views.
  [test: packages/owl-core/tests/observe.test.ts › forEach through a map view hands out views, and the view as the map]
- **Length-changing writes**: a `push` or `splice` through a view reads the length through the view and calls its callback.
  [test: packages/owl-core/tests/observe.test.ts › a push into an observed empty array calls the callback (Odoo website's ResourceEditor errors)]
  [test: packages/owl-core/tests/observe.test.ts › a write that shifts an array through the view calls the callback, as OWL 2's reactive() did]
- **Collection iterators**: collection iterators through a view preserve array members' identity, yield live views and support iterator helpers.
  [test: packages/owl-core/tests/collection_contract.test.ts › Set %s keeps array members as live views]
  [test: packages/owl-core/tests/collection_contract.test.ts › Map %s keeps arrays as live views]
  [test: packages/owl-core/tests/collection_contract.test.ts › iterator helpers keep observing each consumed value]

## Validation

### Schemas

- **A constructor is not a type**: a constructor in a type schema (`{ a: String }`) throws instead of accepting everything.
  [test: packages/owl-core/tests/validation.test.ts › a constructor or a non-function in a shape is rejected, not silently accepted]
- **At the top level too**: a top-level schema is checked as a nested one is, by `validateType` and by a registry's `validation`.
  [test: packages/owl-core/tests/validation.test.ts › a top-level schema is checked as a schema nested in a shape is]
- **An optional custom validator**: a `customValidator` of an optional type is optional, and carries that type's default.
  [test: packages/owl-core/tests/validation.test.ts › a customValidator wrapping an optional type may be omitted, and is not called on undefined]
  [test: packages/owl-core/tests/validation.test.ts › a customValidator wrapping a defaulted type carries the default]
- **`t.ref()` without a DOM**: `t.ref()` can be declared without a DOM; only checking a non-null value needs one.
  [test: packages/owl-core/tests/validation.test.ts › t.ref() is a schema without a DOM, and its validation needs one]

### Defaults

- **Plain data is filled**: `applyDefaults` fills plain data: an object of `null` prototype, an object whose prototype has a `null` prototype (`Object.prototype` of any realm, which is recognized that way), or a plain array.
  [test: packages/owl-core/tests/validation.test.ts › leaves an instance of a class as it is, its kind kept]
- **Anything else is returned as it is**: an instance of a class (an `Array` subclass, an object with private members), or any object further down a prototype chain, is returned as it is, not copied into a plain object.
  [test: packages/owl-core/tests/validation.test.ts › leaves an instance of a class as it is, its kind kept]

### Schema types

- **A schema is not its value**: a schema is typed as a schema, not as the value it describes, so `t.number().toFixed()` and `const s: string = t.string()` do not compile.
  [test: packages/owl-core/tests/specification.test.ts › a schema is typed as a schema, not as the value it describes]
- **No phantom brand**: `Schema<T>` carries `T` under a module-private brand, so the published declarations declare no value the build does not export.
  [test: packages/owl/tests/types_build.test.ts › %s exports every value %s declares, and declares every value it exports]
- **Schemas of entries**: `Registry` and `Resource` take a `Schema<V>` as `validation`, their entries typed `V`, and `useConfig` takes a `Schema<T>`.
  [test: packages/owl-core/tests/specification.test.ts › a registry or resource validation is a schema of its entries, and useConfig takes a schema]
- **`registry.get` with a default**: `registry.get(key, d)` is typed `V | D`.
  [test: packages/owl-core/tests/specification.test.ts › registry.get with a default is typed as the entry or the default]
- **`useListener` targets**: `useListener` takes an event target or any function reading one.
  [test: packages/owl-core/tests/specification.test.ts › useListener takes an event target or any function reading one]
- **`this.constructor`**: a component's `this.constructor` is typed as its class, so `useProps(this.constructor.props)` type-checks.
  [test: packages/owl/tests/types_build.test.ts › a consumer reads a component's static props through this.constructor, as useProps(this.constructor.props) does]

## Plugins

- **A dependency cycle**: a plugin dependency cycle through constructors or field initializers throws `Circular plugin dependency: <path>` instead of overflowing the stack.
  [test: packages/owl-runtime/tests/plugins.test.ts › a dependency cycle between field initializers throws instead of overflowing]
  [test: packages/owl-runtime/tests/plugins.test.ts › a cycle through a setup reports its whole path]
- **Asking for each other in `setup()`**: plugins asking for each other in `setup()` each get the other, which is logged on the `plugin` channel.
  [test: packages/owl-runtime/tests/plugins.test.ts › plugins asking for each other in their setups each get the other]
  [test: packages/owl-runtime/tests/plugins.test.ts › a cycle, and a handout mid-setup, are logged on the plugin channel]
- **A synchronous start failure**: it leaves no later batch pending.
  [test: packages/owl-runtime/tests/plugins.test.ts › a later batch is no longer pending once the first batch failed synchronously]
- **A plugin without a declared id**: a plugin without a declared `static id` is found only for its own class: `getPlugin` and `usePlugin` check `instanceof`, and look past another class of that name to the parent managers.
  [test: packages/owl-runtime/tests/plugins.test.ts › a plugin without a declared id is not handed out for another class of that name]
- **A declared id**: a plugin with a declared `static id` shadows a parent manager's plugin of that id.
  [test: packages/owl-runtime/tests/plugins.test.ts › plugin can be shadowed]
- **A dependency with its dependent's id**: a dependency started implicitly with its dependent's id throws the duplicate-id error instead of being overwritten.
  [test: packages/owl-runtime/tests/plugins.test.ts › plugin depending on another plugin with the same id (start only A, B is started implicitly)]
- **Nested starts**: plugins started from a plugin's `setup()` hold the batch that started it, so neither `ready` nor the manager's status gets ahead of them.
  [test: packages/owl-runtime/tests/plugins.test.ts › plugins started from a plugin's setup are waited for]
  [test: packages/owl-runtime/tests/plugins.test.ts › a plugin's own onWillStart after a nested start does not let ready skip the nested one]
- **A parent's pending plugin**: a plugin of a child manager asking for one its parent has pending throws `not started yet` instead of starting a copy, unless the child lists it.
  [test: packages/owl-runtime/tests/plugins.test.ts › a child manager's plugin does not start its own copy of a plugin its parent has pending]
  [test: packages/owl-runtime/tests/plugins.test.ts › a child manager starts a plugin it lists itself, though its parent has that plugin pending]
- **Deferred behind a pending start**: a plugin deferred behind a pending start is pending too.
  [test: packages/owl-runtime/tests/plugins.test.ts › a plugin deferred behind a pending start is reported as not started yet]
- **A rejected start**: a rejected start does not block later ones.
  [test: packages/owl-runtime/tests/plugins.test.ts › a rejected start does not hold back later starts]
- **Nothing to start**: an empty plugin list or resource leaves the manager ready.
  [test: packages/owl-runtime/tests/plugins.test.ts › an empty plugin list leaves the manager ready, as no list does]
- **A resource-driven start**: a start driven by a resource belongs to its manager, not to the effect it was called in.
  [test: packages/owl-runtime/tests/plugins.test.ts › a resource-driven start made inside an effect outlives that effect's run]
  [test: packages/owl-core/tests/ownership.test.ts › a plugin started from a resource's effect keeps its effects when that effect re-runs]
- **`startPlugin`**: starting a plugin runs in its manager's scope, untracked, and a destroyed manager refuses it.
  [test: packages/owl-runtime/tests/plugins.test.ts › a plugin started directly runs in its manager's scope]
  [test: packages/owl-runtime/tests/plugins.test.ts › starting plugins from an effect does not subscribe it to what they read]
  [test: packages/owl-runtime/tests/plugins.test.ts › a destroyed manager starts no plugin]
- **Teardown order**: plugins are torn down before the plugins they use: each plugin's destroy callbacks are one group, registered when its start ends, and groups run in reverse order of completion.
  [test: packages/owl-runtime/tests/plugins.test.ts › a plugin is torn down before the plugins it uses, whenever it asked for them]
- **Config keys**: `useConfig` ignores `Object.prototype` members.
  [test: packages/owl-runtime/tests/plugins.test.ts › a config key named like an Object.prototype member is unset]
- **A failed App constructor**: an App whose constructor fails while starting plugins destroys the plugins started before and unregisters itself.
  [test: packages/owl-runtime/tests/app/startup_cleanup.test.ts › failed synchronous plugin startup unregisters the app and releases earlier plugins]

## Registries

- **A forced `use()`**: a `registry.use()` with `{ force: true }` restores the entry it overwrote when it ends.
  [test: packages/owl-core/tests/registry.test.ts › with { force: true } overwrites an existing key]
  [test: packages/owl-core/tests/registry.test.ts › overrides stacked with { force: true } restore the nearest one still in use]
