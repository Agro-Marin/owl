# Proxies

The `proxy` function creates a reactive proxy for an object. Reading a property
subscribes to it, and writing a property notifies subscribers. Nested objects
are recursively wrapped in proxies:

```js
const p = proxy({ a: { b: 3 }, c: 2 });

p.a; // returns a proxy for { b: 3 }
p.a.b; // returns 3, subscribes to both "a" and "b"
p.c; // returns 2, subscribes to "c"
```

`proxy` is **not** a hook — it can be called anywhere, at any time. It works
with objects, arrays, Maps, Sets, and WeakMaps.

A proxy is one of the four reactive primitives. See [Reactivity](reactivity.md)
for how it relates to [signals](signals.md),
[computed values](computed_values.md), and [effects](effects.md).

## Using proxy in components

```js
class TodoList extends Component {
  static template = xml`
    <div>
      <input t-model.proxy="this.state.text"/>
      <button t-on-click="add">Add</button>
      <ul>
        <li t-foreach="this.state.items" t-as="item" t-key="item">
          <t t-out="item"/>
        </li>
      </ul>
    </div>`;

  state = proxy({ text: "", items: [] });

  add() {
    this.state.items.push(this.state.text);
    this.state.text = "";
  }
}
```

Note the use of `t-model.proxy` to bind an input to a proxy property (see
[Form Bindings](form_bindings.md) for details).

## markRaw

Marks an object so that it is never wrapped in a reactive proxy. This is useful
to avoid the overhead of proxy creation for large, immutable data:

```js
const raw = markRaw({ label: "text", value: 42 });
const state = proxy({ items: [raw] });

state.items[0] === raw; // true — not proxified
```

**Caveat:** mutations to marked-raw objects will **not** trigger updates. Only
use `markRaw` when you know the object won't change, or when profiling reveals
that proxy creation is a performance bottleneck.

Marking a class prototype marks the class: every instance of it, and of its
subclasses, is handed out as it is. A class with private members (`#x`) needs
it, since a proxy does not have them: a getter or setter reaching one through
a proxy throws an error that names the class to mark. A private member error
the object's own classes do not declare (a bug in code the getter calls) is
rethrown as the engine threw it. The prototype of a built-in (`Object`, `Array`,
`Map`, `Set`, `WeakMap`, `Function`) cannot be marked: `markRaw` throws
rather than leave every plain object or array unobserved.

```js
class Secret {
  #value = 1;
  get value() {
    return this.#value;
  }
}
markRaw(Secret.prototype);
proxy({ secret: new Secret() }).secret.value; // 1
```

## toRaw

Given a proxy, returns the underlying non-proxy object. Useful for identity
comparison and debugging:

```js
const target = { a: 1 };
const p = proxy(target);

p === target; // false (p is a proxy)
toRaw(p) === target; // true
```

## observe

`observe(target, callback)` returns a view of `target` that calls `callback`,
synchronously, the first time a value read through the view changes — OWL 2's
`reactive(target, callback)`:

```js
const state = proxy({ count: 0, label: "a" });
const view = observe(state, () => console.log("changed"));

view.count; // the view now observes `count`
state.label = "b"; // nothing: `label` was not read through the view
state.count = 1; // logs "changed"
state.count = 2; // nothing: the subscription is one-shot
view.count; // read again: observed again
```

- The subscription is **one-shot**: once `callback` ran, only the values read
  through the view again are observed. A callback that reads the view stays
  subscribed to what it read.
- Objects read through the view are views too, with the same callback.
- Reads through the view still subscribe the computation they happen in (a
  render, an effect), as a plain proxy read does.
- An array method that changes the length (`push`, `pop`, `shift`, `unshift`,
  `splice`) reads the length through the view, so pushing through it calls
  `callback`, as OWL 2's `reactive([], callback)` did.
- Use it to bridge to code that expects a callback; within components, prefer
  `proxy` with `effect` or a render.
