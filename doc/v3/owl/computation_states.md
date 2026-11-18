# Computations and links: the state machine

The reactivity core (`packages/owl-core/src/computations.ts`) keeps a graph of
**atoms** (signals, proxy keys, computeds) and **computations** (computeds,
effects, renders, `observe()` callbacks), joined by **links**. This page is
the reference for what each state and flag means and which function changes
it; the behaviour it produces is stated, rule by rule with its test, in
[the specification](specification.md#reactivity). Read it before changing
`computations.ts`.

## Atoms

An atom holds a `value` and the doubly linked list of links to the
computations that read it (`subs` … `subsTail`). A computation is an atom
too (`isDerived` for a computed), so a computed has both readers and
sources. `holder.release(atom)` is called when its last reader goes
(`unlinkSub`), so a proxy can drop the atom of a key nobody reads.

`activeLink` is the link of the computation currently reading the atom, used
to find an existing link in one step when the same computation reads the
atom again. A nested run reading the same atom saves the previous one in its
link's `rollback`; `endTracking` restores it, skipping dead links
(`liveRollback`). Invariant: `activeLink` is never dead (checked by the
`invariant` debug channel in `track`).

## Links

A link joins one source (`dep`) to one computation (`sub`), sitting in two
lists: the computation's sources (`deps` … `depsTail`, in read order) and the
source's readers (`subs` … `subsTail`).

| `version`           | Meaning                                                                                                                                                      | Set by                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| the sub's `version` | current: the computation read the source in its latest run; a write to the source notifies it                                                                | `track`, `reuse` (a run reading it); `endWrittenLinks` (back from WRITTEN at the run's end) |
| an older version    | stale: read in an earlier run and not yet removed; a write skips it                                                                                          | a new run (`runTracked` increments the sub's version)                                       |
| `WRITTEN` (-2)      | the running sub read the source, then the source was written during that run: the sub keeps what it read and stays an observer (`isLive`) until the run ends | `writtenWhileRunning` (from `onWriteAtom`)                                                  |
| `DEAD` (-1)         | removed from the source's readers; kept only as a rollback a nested run may hand back past                                                                   | `unlinkSub`                                                                                 |

`seen` is the value of a non-derived source when the link last read it; a
PENDING check compares it with the source's value (`Object.is`). A link whose source is the `writeMark` atom is a marker `writtenWhileRunning`
appends when the written link is the computation's tail: `onReadAtom` skips
tracking a read of the tail's own source, so without it a read of the source
right after the write would not reach `track`, which refreshes what the
WRITTEN link saw (`readAgainAfterWrite`); `endWrittenLinks` removes it.

## A computation's state

| `state`    | Meaning                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXECUTED` | up to date: its value (a computed) or its last run (an effect) reflects its sources                                                                   |
| `PENDING`  | a source **may** have changed: a computed source was invalidated, or a signal with the default equality was written. Check the sources before running |
| `STALE`    | a source changed: run again                                                                                                                           |
| `RUNNING`  | running, and not invalidated since the run started                                                                                                    |

Transitions (the function that makes each):

| From → to                     | When                                                                                                                                                                                                | Function                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| created → `STALE`             | a computed or an effect not yet run (renders and `observe()` callbacks start `EXECUTED`)                                                                                                            | `createComputation`                   |
| `EXECUTED` → `PENDING`        | a written signal with the default equality (`comparable`), or an invalidated computed source; queued (effect), pushed (immediate) or walked through (computed)                                      | `onWriteAtom`, `markDownstream`       |
| `EXECUTED` → `STALE`          | the same, for a signal with a custom `equals`, or for a computation with `notifiesWithoutRecompute` (an `observe()` callback, which has no sources to check)                                        | `onWriteAtom`, `markDownstream`       |
| `RUNNING` → `PENDING`/`STALE` | a source written during the run: the run continues, and it ends out of date                                                                                                                         | `onWriteAtom`, `markDownstream`       |
| `PENDING` → `EXECUTED`        | every source checked unchanged (`checkSources`: a signal by `seen`, a computed by bringing it up to date, which marks this one `STALE` if its value changed)                                        | `refresh`                             |
| `PENDING` → `STALE`           | a checked source changed                                                                                                                                                                            | `checkSources`, or the source's write |
| `STALE` → `RUNNING`           | a run starts (`running` set)                                                                                                                                                                        | `refresh`                             |
| `RUNNING` → `EXECUTED`        | the run ends without having been invalidated                                                                                                                                                        | `refresh`                             |
| invalidated run → …           | a computed ends `PENDING`/`STALE` with `forward` set (its readers keep the value it returned); an effect ends `EXECUTED` (its WRITTEN links make the next write run it); both forward their sources | `endInvalidatedRun`                   |
| any → `STALE` / `EXECUTED`    | disposal: a computed becomes `STALE` (read again, it recomputes), an effect `EXECUTED`                                                                                                              | `disposeComputation`                  |
| `PENDING` → `EXECUTED`        | a source threw during the check: the error is thrown, the computation keeps its value                                                                                                               | `checkSources`                        |

## A computation's flags

| Flag                           | Meaning                                                                                                                                                                                     | Set / cleared by                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `running`                      | its compute is on the stack. Unlike `state === RUNNING`, it stays set when a write invalidates the run; reading the computation while it is set is the cycle error                          | `refresh`                                                                                 |
| `checking`                     | its sources are being checked (`PENDING` → ?): an owner being checked is not run ahead of the effect it owns                                                                                | `checkSources`                                                                            |
| `forward`                      | a computed out of date whose readers hold its last value: the next write reaching it passes through to them (`forwardThrough`) instead of being absorbed by its own `PENDING`/`STALE` state | `endInvalidatedRun`, `forwardPendingSources`; cleared on a run, a check's end, a disposal |
| `version`                      | the run counter: a link is current when its `version` equals it                                                                                                                             | `runTracked`, `detachAndRun`                                                              |
| `prepared`                     | in the current run, the remaining old links were made their sources' `activeLink`, so a read in a new order still finds its old link                                                        | `track` (first out-of-order read); reset by `runTracked`                                  |
| `notifiesWithoutRecompute`     | invalidation makes it `STALE` directly, never `PENDING`: an `observe()` callback, whose links are its views' reads, not a run's                                                             | `observe()` (proxy.ts)                                                                    |
| `tracksElsewhere`              | its compute runs untracked (`detachAndRun`): a component's render computation, whose reads are tracked by the render itself                                                                 | `ComponentNode`                                                                           |
| `observed`, `lateReads`        | for an `observe()` callback: the sources its views linked outside a run (deduplicated), and the reads made between an invalidation and its run, replayed when it runs (`trackLateReads`)    | `onReadAtom`; cleared by `endTracking`, `removeSources`                                   |
| `owner`, `owned`, `ownerDepth` | the computation whose run created it, the disposers of what it created, and the scope depth of its last run (`getOwner` gives an owner only at the same depth)                              | `effect.ts`, `runTracked`, `releaseOwned`                                                 |
| `immediate`, `isEffect`        | an immediate effect runs at the end of the write (or batch) instead of at the flush                                                                                                         | `createComputation`, `effect.ts`                                                          |

## Scheduling

A write runs the immediate effects it queued at its end, or at the end of the
outermost `batch` (bringing a computed up to date is a batch); effects are
queued to the flush, a microtask scheduled only when a write queues something
no scheduled flush will run (`flushWanted`, `flushScheduled`). The flush runs
the queued effects, owners first (`updateOwnerFirst`), then disposes the
computeds queued for disposal that nothing observes any more
(`pendingDisposals`).
