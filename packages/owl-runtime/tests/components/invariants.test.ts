import { debug, OwlError } from "@odoo/owl-core";
import { App, Component, onWillUpdateProps, props, proxy, xml } from "../../src";
import { Scheduler } from "../../src/rendering/scheduler";
import { STATUS } from "../../src/status";
import { makeDeferred, makeTestFixture, nextTick } from "../helpers";

// The `invariant` debug channel's checks (B.2 of the best-in-class plan), each
// shown to fire on the state it forbids. The state is corrupted by hand: no
// correct sequence of renders reaches it, which is what the checks assert.

let fixture: HTMLElement;

// toThrow(/re/) also passes when undefined is thrown: the error is checked whole.
function frameError(scheduler: Scheduler): unknown {
  try {
    scheduler.processTasks();
  } catch (error) {
    return error;
  }
  return null;
}

function expectInvariant(error: unknown, message: string) {
  expect(error).toBeInstanceOf(OwlError);
  expect((error as Error).message).toBe(message);
}

beforeEach(() => {
  fixture = makeTestFixture();
});

class Leaf extends Component {
  static template = xml`<i t-out="this.props.v"/>`;
  props = props();
}

// A mounted root with a pass waiting on a child's onWillUpdateProps, its task
// kept by the scheduler, which no frame has processed yet.
async function waitingPass() {
  const load = makeDeferred();
  class Slow extends Component {
    static template = xml`<s t-out="this.props.v"/>`;
    props = props();
    setup() {
      onWillUpdateProps(() => load);
    }
  }
  class Root extends Component {
    static template = xml`<div><Slow v="this.state.v"/><Leaf v="this.state.v"/></div>`;
    static components = { Slow, Leaf };
    state = proxy({ v: 1 });
  }
  const app = new App({ test: true });
  const root = await app.createRoot(Root).mount(fixture);
  const scheduler = app.scheduler;
  const requestFrame = scheduler.requestAnimationFrame;
  scheduler.requestAnimationFrame = () => 1;
  root.state.v = 2;
  await nextTick();
  const [task] = scheduler.tasks;
  return {
    app,
    scheduler,
    task,
    load,
    restore: () => (scheduler.requestAnimationFrame = requestFrame),
  };
}

test("a pass whose counter differs from its unrendered fibers fails the frame", async () => {
  const { app, scheduler, task, restore } = await waitingPass();
  task.counter += 1;
  expectInvariant(
    frameError(scheduler),
    "invariant: Root's pass counts 2 render(s) pending, its tree 1"
  );
  task.counter -= 1;
  restore();
  app.destroy();
});

test("a task that is not a root fiber fails the frame", async () => {
  const { app, scheduler, task, restore } = await waitingPass();
  const root = task.root;
  task.root = null;
  expectInvariant(frameError(scheduler), "invariant: a task of Root is not a root fiber");
  task.root = root;
  restore();
  app.destroy();
});

test("a frame that keeps a task of a destroyed component fails", async () => {
  const { app, scheduler, task, restore } = await waitingPass();
  task.node.status = STATUS.DESTROYED;
  expectInvariant(
    frameError(scheduler),
    "invariant: a frame kept a task of Root that is not its live pass"
  );
  task.node.status = STATUS.MOUNTED;
  restore();
  app.destroy();
});

test("a scheduler that keeps tasks but is not active fails the frame", async () => {
  const { app, scheduler, restore } = await waitingPass();
  Scheduler.active.delete(scheduler);
  expectInvariant(frameError(scheduler), "invariant: a scheduler holding tasks is not active");
  restore();
  app.destroy();
});

test("with the channel off, nothing is checked", async () => {
  const { app, scheduler, task, load, restore } = await waitingPass();
  debug.invariant = false;
  task.counter += 1;
  expect(frameError(scheduler)).toBe(null);
  task.counter -= 1;
  debug.invariant = true;
  restore();
  load.resolve();
  app.destroy();
});
