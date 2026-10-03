# Debug Logging

Owl can trace what it does — writes and the effects they re-run, renders and
commits, lifecycle hooks, how an error was routed — one channel at a time. It is
off by default; a disabled channel costs one property read where it would log.

## Enabling it

```js
import { setDebug } from "@odoo/owl";

setDebug(true); // every channel
setDebug(["fiber", "scheduler"]); // some channels
setDebug("fiber,error"); // the same, as a string
setDebug(false); // none
```

An unknown channel name throws, with the list of the valid ones. In a running
Odoo, the same call works from the browser console:
`odoo.loader.modules.get("@odoo/owl").setDebug("fiber,error")`.

Lines go to `console.debug` (shown under the console's _Verbose_ level) as
`[owl:<channel>] <message>`, followed by the objects involved, which the console
lets you inspect. `setDebugSink(fn)` sends them elsewhere — a test asserting on
them, a ring buffer — and `setDebugSink(null)` restores the console:

```js
const lines = [];
setDebugSink((channel, message, details) => lines.push(`${channel}: ${message}`));
```

## Channels

| Channel      | Traces                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `reactivity` | every write to a signal, computed or proxy key, with the names of the computations it invalidates                           |
| `effect`     | an effect's creation (and its owner), runs, disposal; each flush and the effects it runs                                    |
| `computed`   | recomputes, an equal result that keeps readers, a failure kept as the value, disposal of a computed nobody reads            |
| `scope`      | a scope's teardown, a rolled-back setup, a guarded promise aborted because its scope died                                   |
| `plugin`     | each plugin start with its dependency path, batches and their `onWillStart`, an undone start, readiness                     |
| `scheduler`  | a render pass scheduled, each animation frame and what it does with every pass: commit, wait, drop (and why)                |
| `fiber`      | each component render and its duration, a child kept or updated (and why), a render delayed behind an ancestor, each commit |
| `lifecycle`  | setup, `onWillStart` started and settled, `onMounted`/`onPatched` calls, destruction, roots created, apps destroyed         |
| `error`      | which component's error was handled by an ancestor's `onError` or destroyed the app; a computation that threw               |
| `template`   | each template compiled (time and size) or loaded precompiled                                                                |
| `event`      | each event a template handler receives, and whether it ran                                                                  |

## Names

Logs name components by their class. Effects and computed values are anonymous
functions, so they log as `effect` and `computed` unless given a name:

```js
effect(() => console.log(count()), { name: "logCount" });
const total = computed(() => price() * qty(), { name: "total" });
```

Without that option, the function's own name is used if the channel is already
enabled when the effect or computed is created.
