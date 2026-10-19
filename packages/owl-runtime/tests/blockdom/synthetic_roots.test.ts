import { createBlock, mount } from "../../src/blockdom";
import { setDebug, setDebugSink } from "@odoo/owl-core";
import { makeTestFixture } from "./helpers";

class TestWeakRef {
  static refs: TestWeakRef[] = [];
  target: any;
  constructor(target: any) {
    this.target = target;
    TestWeakRef.refs.push(this);
  }
  deref() {
    return this.target;
  }
}

test("a collected shadow root no longer sends the synthetic events of the others on the slow path", () => {
  vi.stubGlobal("WeakRef", TestWeakRef);
  const messages: string[] = [];
  setDebugSink((_channel, message) => messages.push(message));
  setDebug(["event"]);
  try {
    const handlers = [(ctx: any, ev: Event) => ctx(ev)];
    const type = createBlock('<p block-handler-0="click.synthetic">x</p>', handlers);
    const calls: string[] = [];
    const host = makeTestFixture();
    const shadow = host.attachShadow({ mode: "open" });
    mount(type([() => calls.push("shadow")], null, handlers), shadow);
    host.remove();
    const fixture = document.createElement("div");
    document.body.appendChild(fixture);
    mount(type([() => calls.push("document")], null, handlers), fixture);
    const replays = () => messages.filter((m) => m.includes("replayed by its")).length;

    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["document"]);
    expect(replays()).toBe(1);

    const ref = TestWeakRef.refs.find((r) => r.target === shadow)!;
    ref.target = undefined;
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["document", "document"]);
    expect(replays()).toBe(1);
    expect(messages).toContain("1 collected synthetic roots dropped");
    fixture.remove();
  } finally {
    setDebug(false);
    setDebugSink(null);
    vi.unstubAllGlobals();
  }
});
