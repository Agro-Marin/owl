// Random reactive programs, an interpreter that runs one against a reactive
// API and logs what ran, and a reference model of that API: the contract of
// doc/v3/owl/reference/{reactivity,effects,computed_values}.md and of the
// Reactivity section of doc/v3/owl/fork_3.0-marin.md, written with arrays of
// readers and sources instead of links, and an explicit microtask queue in
// which a flush, a promise callback and the program's own `await` take their
// turn.
//
// The log has one entry per event: `e3>` and `e3< 1,0` (effect 3 starts, and
// ends having read 1 then 0), `e3 cleanup`, `c1>` / `c1< 2` (a computed's
// getter and its value), `s0:=2` (a write, prefixed by who wrote it),
// `queue m7` / `m7` (a promise callback queued, and run), `tick`, `drain`.
// runProgram's `trace` and the model's interleave it with Owl's debug
// channels (setDebug) and the model's own steps, to see where two logs part.

export type Ref = { s: number } | { c: number } | { o: number };

export type Value = { k: number } | { acc: number };

export type Op =
  | { op: "read"; ref: Ref }
  | { op: "branch"; ref: Ref; then: Op[]; else: Op[] }
  | { op: "untrack"; body: Op[] }
  | { op: "write"; s: number; value: Value }
  | { op: "effect"; spec: EffectSpec }
  | { op: "microtask"; body: Op[] }
  | { op: "batch"; body: Op[] }
  | { op: "dispose"; pick: number }
  | { op: "tick" };

export interface EffectSpec {
  immediate: boolean;
  detached: boolean;
  cleanup: boolean;
  body: Op[];
}

export interface ComputedSpec {
  mod: number;
  output: number | null;
  body: Op[];
}

export interface Program {
  signals: number;
  outputs: number;
  computeds: ComputedSpec[];
  steps: Op[];
}

export interface ReactiveApi {
  signal(value: number): { (): number; set(value: number): void };
  computed(getter: () => number, options: { name: string }): () => number;
  effect(fn: () => unknown, options: { detached: boolean; name: string }): () => void;
  immediateEffect(fn: () => unknown, options: { detached: boolean; name: string }): () => void;
  batch(fn: () => void): void;
  untrack<T>(fn: () => T): T;
  microtask(fn: () => void): void;
  tick(): Promise<void>;
  drain(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Generator

const VALUES = 4;

function int(random: () => number, n: number): number {
  return Math.floor(random() * n);
}

function chance(random: () => number, p: number): boolean {
  return random() < p;
}

interface Scope {
  // a body reads signals, outputs and the computeds below `computeds`
  computeds: number;
  writes: boolean;
  effects: boolean;
  dispose: boolean;
  depth: number;
  restricted: boolean;
}

function genRef(random: () => number, program: Program, scope: Scope): Ref {
  const roll = random();
  if (roll < 0.45 && scope.computeds) {
    return { c: int(random, scope.computeds) };
  }
  if (roll < 0.6 && program.outputs) {
    return { o: int(random, program.outputs) };
  }
  return { s: int(random, program.signals) };
}

function genValue(random: () => number): Value {
  return chance(random, 0.5) ? { k: int(random, VALUES) } : { acc: int(random, VALUES) };
}

function genBody(random: () => number, program: Program, scope: Scope, length: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < length; i++) {
    ops.push(genOp(random, program, scope));
  }
  return ops;
}

function genOp(random: () => number, program: Program, scope: Scope): Op {
  const nested = scope.depth < 3;
  const inner = { ...scope, depth: scope.depth + 1 };
  for (;;) {
    const roll = int(random, 20);
    if (roll < 6) {
      return { op: "read", ref: genRef(random, program, scope) };
    }
    if (roll < 8 && nested) {
      return {
        op: "branch",
        ref: genRef(random, program, scope),
        then: genBody(random, program, inner, 1 + int(random, 2)),
        else: genBody(random, program, inner, int(random, 2)),
      };
    }
    if (roll < 9 && nested) {
      return { op: "untrack", body: genBody(random, program, inner, 1) };
    }
    if (roll < 12 && scope.writes) {
      return { op: "write", s: int(random, program.signals), value: genValue(random) };
    }
    if (roll < 14 && scope.effects && nested) {
      return { op: "effect", spec: genEffect(random, program, scope) };
    }
    if (roll < 16 && nested) {
      // runs later, at top level
      const later: Scope = {
        computeds: program.computeds.length,
        writes: true,
        effects: true,
        dispose: true,
        depth: inner.depth,
        restricted: scope.restricted,
      };
      return { op: "microtask", body: genBody(random, program, later, 1 + int(random, 2)) };
    }
    if (roll < 17 && nested) {
      return { op: "batch", body: genBody(random, program, inner, 1 + int(random, 3)) };
    }
    if (roll < 18 && scope.dispose) {
      return { op: "dispose", pick: int(random, 1000) };
    }
  }
}

function genEffect(random: () => number, program: Program, scope: Scope): EffectSpec {
  const immediate = chance(random, 0.4);
  const inner: Scope = { ...scope, depth: scope.depth + 1 };
  if (scope.restricted) {
    inner.dispose = false;
    inner.writes &&= !immediate;
  }
  return {
    immediate,
    detached: chance(random, 0.15),
    cleanup: chance(random, 0.6),
    body: genBody(random, program, inner, 1 + int(random, 4)),
  };
}

export interface GenerateOptions {
  // Only what af18b4f5 already did as the model says: no getter writes a
  // signal and no immediate effect writes one (nor what it creates), which
  // ran immediate effects inside an evaluation or wrote during a check; no
  // effect disposes one, which a write later in that run could run again.
  af18b4f5?: boolean;
}

export function generateProgram(random: () => number, options: GenerateOptions = {}): Program {
  const restricted = !!options.af18b4f5;
  const signals = 2 + int(random, 3);
  const outputs = restricted ? 0 : int(random, 3);
  const program: Program = { signals, outputs, computeds: [], steps: [] };
  const computedCount = int(random, 5);
  const writers = new Set<number>();
  for (let i = 0; i < computedCount; i++) {
    // A getter reads earlier computeds only, and so do the effects it
    // creates (they run at once, inside it): a later one may read it.
    const scope: Scope = {
      computeds: i,
      writes: !restricted,
      effects: true,
      dispose: false,
      depth: 1,
      restricted,
    };
    const body = genBody(random, program, scope, 1 + int(random, 3));
    let output: number | null = null;
    if (outputs && chance(random, 0.5)) {
      const o = int(random, outputs);
      if (!writers.has(o)) {
        writers.add(o);
        output = o;
      }
    }
    program.computeds.push({ mod: 2 + int(random, 3), output, body });
  }
  const top: Scope = {
    computeds: program.computeds.length,
    writes: true,
    effects: true,
    dispose: true,
    depth: 0,
    restricted,
  };
  const length = 4 + int(random, 12);
  for (let i = 0; i < length; i++) {
    const roll = int(random, 10);
    if (roll < 3 || i < 1) {
      program.steps.push({ op: "effect", spec: genEffect(random, program, top) });
    } else if (roll < 5) {
      program.steps.push({ op: "tick" });
    } else {
      program.steps.push(genOp(random, program, top));
    }
  }
  return program;
}

// ---------------------------------------------------------------------------
// Interpreter

const WRITE_BUDGET = 40;
const LOG_BUDGET = 3000;

export async function runProgram(
  program: Program,
  api: ReactiveApi,
  trace?: (entry: string) => void
): Promise<string[]> {
  const log: string[] = [];
  let writes = WRITE_BUDGET;
  let runaway = false;
  const handles: (() => void)[] = [];
  const signals = Array.from({ length: program.signals }, () => api.signal(0));
  const outputs = Array.from({ length: program.outputs }, () => api.signal(0));
  const computeds: (() => number)[] = [];

  function emit(entry: string) {
    if (log.length >= LOG_BUDGET) {
      if (!runaway) {
        runaway = true;
        log.push("runaway");
      }
      return;
    }
    log.push(entry);
    trace?.(entry);
  }

  function read(ref: Ref): number {
    if ("s" in ref) return signals[ref.s]();
    if ("o" in ref) return outputs[ref.o]();
    return computeds[ref.c]();
  }

  function name(ref: Ref): string {
    return "s" in ref ? `s${ref.s}` : "o" in ref ? `o${ref.o}` : `c${ref.c}`;
  }

  function errorText(error: unknown): string {
    const message = String((error as Error)?.message ?? error);
    return message.includes("Cycle") ? "cycle" : message;
  }

  function exec(ops: Op[], acc: number[], where: string) {
    for (const op of ops) {
      if (runaway) return;
      switch (op.op) {
        case "read": {
          const value = read(op.ref);
          acc.push(value);
          if (where === "") emit(`read ${name(op.ref)}=${value}`);
          break;
        }
        case "branch": {
          const value = read(op.ref);
          acc.push(value);
          exec(value % 2 ? op.then : op.else, acc, where);
          break;
        }
        case "untrack":
          api.untrack(() => exec(op.body, acc, where));
          break;
        case "write": {
          if (where !== "") {
            if (writes === 0) break;
            writes--;
          }
          const value =
            "k" in op.value ? op.value.k : (acc.reduce((a, b) => a + b, 0) + op.value.acc) % VALUES;
          emit(`${where}s${op.s}:=${value}`);
          signals[op.s].set(value);
          break;
        }
        case "effect":
          createEffect(op.spec);
          break;
        case "microtask": {
          const id = log.length;
          emit(`${where}queue m${id}`);
          api.microtask(() => {
            emit(`m${id}`);
            guarded(() => exec(op.body, [], `m${id} `), `m${id}`);
          });
          break;
        }
        case "batch":
          api.batch(() => exec(op.body, acc, where));
          break;
        case "dispose":
          if (handles.length) {
            const id = op.pick % handles.length;
            emit(`${where}dispose e${id}`);
            handles[id]();
          }
          break;
        case "tick":
          throw new Error("tick inside a body");
      }
    }
  }

  function guarded(fn: () => void, who: string) {
    try {
      fn();
    } catch (error) {
      emit(`${who} threw ${errorText(error)}`);
    }
  }

  function createEffect(spec: EffectSpec) {
    const id = handles.length;
    handles.push(() => {});
    const fn = () => {
      const acc: number[] = [];
      emit(`e${id}>`);
      guarded(() => exec(spec.body, acc, `e${id} `), `e${id}`);
      emit(`e${id}< ${acc.join(",")}`);
      return spec.cleanup ? () => emit(`e${id} cleanup`) : undefined;
    };
    const create = spec.immediate ? api.immediateEffect : api.effect;
    handles[id] = create(fn, { detached: spec.detached, name: `e${id}` });
  }

  program.computeds.forEach((spec, i) => {
    computeds.push(
      api.computed(
        () => {
          const acc: number[] = [];
          emit(`c${i}>`);
          guarded(() => exec(spec.body, acc, `c${i} `), `c${i}`);
          const value = (acc.reduce((a, b) => a + b, 0) + i) % spec.mod;
          if (spec.output !== null) {
            emit(`c${i} o${spec.output}:=${value}`);
            outputs[spec.output].set(value);
          }
          emit(`c${i}< ${value}`);
          return value;
        },
        { name: `c${i}` }
      )
    );
  });

  for (const step of program.steps) {
    if (step.op === "tick") {
      emit("tick");
      await api.tick();
    } else {
      guarded(() => exec([step], [], ""), "step");
    }
  }
  emit("drain");
  await api.drain();
  emit("dispose all");
  for (const handle of handles) {
    guarded(handle, "dispose");
  }
  await api.drain();
  return log;
}

// ---------------------------------------------------------------------------
// Reference model

// typed as numbers: a check changes a computation's state behind the
// compiler's back
const CLEAN: number = 0;
const PENDING: number = 1;
const STALE: number = 2;

interface ModelSignal {
  kind: "signal";
  value: number;
  subs: ModelComputation[];
}

interface Dep {
  node: ModelSignal | ModelComputation;
  seen: number;
  // written while the effect that read it was still running
  written?: boolean;
}

interface ModelComputation {
  kind: "computed" | "effect";
  name: string;
  fn: () => unknown;
  immediate: boolean;
  state: number;
  running: boolean;
  // its sources are being checked
  checking: boolean;
  // out of date, but passes the next write on to its readers (one holds it)
  forward: boolean;
  deps: Dep[];
  newDeps: Dep[] | null;
  subs: ModelComputation[];
  value: unknown;
  hasValue: boolean;
  changed: boolean;
  // a write reached it while it ran: PENDING or STALE
  invalidated: number;
  owned: ModelComputation[];
  owner: ModelComputation | null;
  disposed: boolean;
}

export interface ModelOptions {
  // af18b4f5's deliberate differences, and one defect the generated programs
  // reach without the restrictions of GenerateOptions: every write schedules
  // a flush (not only one that queues an effect or a disposal), only the
  // outermost due owner runs before an effect, and a running effect is no
  // observer of a source it read and then saw written.
  af18b4f5?: boolean;
  // receives what the model does, as Owl's debug channels do
  trace?: (message: string) => void;
}

export class ReactiveModel {
  private queue: (() => void)[] = [];
  private observers: ModelComputation[] = [];
  private immediates: ModelComputation[] = [];
  private disposals = new Set<ModelComputation>();
  private flushScheduled = false;
  private flushWanted = false;
  private batchDepth = 0;
  private writes = 0;
  private tracking: ModelComputation | null = null;
  private owner: ModelComputation | null = null;
  private af18: boolean;
  private trace: (message: string) => void;

  constructor(options: ModelOptions = {}) {
    this.af18 = !!options.af18b4f5;
    this.trace = options.trace ?? (() => {});
  }

  api(): ReactiveApi {
    return {
      signal: (value) => this.signal(value),
      computed: (getter, options) => this.computed(getter, options.name),
      effect: (fn, options) => this.effect(fn, false, options.detached, options.name),
      immediateEffect: (fn, options) => this.effect(fn, true, options.detached, options.name),
      batch: (fn) => this.batch(fn),
      untrack: (fn) => this.untrack(fn),
      microtask: (fn) => this.queue.push(fn),
      tick: () => {
        let reached = false;
        this.queue.push(() => (reached = true));
        while (!reached) this.queue.shift()!();
        return Promise.resolve();
      },
      drain: () => {
        while (this.queue.length) this.queue.shift()!();
        return Promise.resolve();
      },
    };
  }

  private node(kind: "computed" | "effect", fn: () => unknown, immediate: boolean, name: string) {
    const node: ModelComputation = {
      kind,
      name,
      fn,
      immediate,
      state: STALE,
      running: false,
      checking: false,
      forward: false,
      deps: [],
      newDeps: null,
      subs: [],
      value: undefined,
      hasValue: false,
      changed: false,
      invalidated: CLEAN,
      owned: [],
      owner: null,
      disposed: false,
    };
    return node;
  }

  signal(value: number) {
    const atom: ModelSignal = { kind: "signal", value, subs: [] };
    const read = () => {
      this.track(atom);
      return atom.value;
    };
    read.set = (next: number) => {
      if (Object.is(atom.value, next)) return;
      atom.value = next;
      this.notify(atom, true);
    };
    return read;
  }

  computed(getter: () => number, name: string) {
    const node: ModelComputation = this.node(
      "computed",
      () => {
        const next = getter();
        if (node.hasValue && Object.is(node.value, next)) return;
        node.changed = node.hasValue;
        node.hasValue = true;
        node.value = next;
      },
      false,
      name
    );
    return () => {
      this.read(node);
      return node.value as number;
    };
  }

  effect(fn: () => unknown, immediate: boolean, detached: boolean, name: string) {
    const node: ModelComputation = this.node(
      "effect",
      () => {
        if (typeof node.value === "function" || node.owned.length) {
          this.unowned(() => this.release(node));
        }
        const result = fn();
        node.value = typeof result === "function" ? result : undefined;
        if (node.disposed) {
          // disposed by its own run (its owner re-ran inside it): it keeps
          // no subscription, and the cleanup it just returned runs
          this.detach(node);
        }
      },
      immediate,
      name
    );
    const owner = detached ? null : (this.tracking ?? this.owner);
    if (owner) {
      owner.owned.push(node);
      node.owner = owner;
    }
    this.update(node);
    return () => this.disposeEffect(node);
  }

  batch(fn: () => void) {
    this.batchDepth++;
    try {
      fn();
    } finally {
      if (--this.batchDepth === 0 && this.immediates.length) {
        const toRun = this.immediates;
        this.immediates = [];
        this.updateEach(toRun);
      }
    }
  }

  untrack<T>(fn: () => T): T {
    const tracking = this.tracking;
    const owner = this.owner;
    this.owner = tracking ?? owner;
    this.tracking = null;
    try {
      return fn();
    } finally {
      this.tracking = tracking;
      this.owner = owner;
    }
  }

  private unowned(fn: () => void) {
    const tracking = this.tracking;
    const owner = this.owner;
    this.tracking = this.owner = null;
    try {
      fn();
    } finally {
      this.tracking = tracking;
      this.owner = owner;
    }
  }

  // A computation follows what its last run read, in the order it first read
  // each; a source keeps its readers in the order they started reading it.
  private track(node: ModelSignal | ModelComputation) {
    const sub = this.tracking;
    if (!sub) return;
    const seen = node.kind === "signal" ? node.value : 0;
    const dep = sub.newDeps!.find((d) => d.node === node);
    if (dep) {
      // an effect follows the value it read last, a computed the first
      if (sub.kind === "effect") dep.seen = seen;
      return;
    }
    const kept = sub.deps.find((d) => d.node === node);
    if (kept) {
      kept.seen = seen;
      sub.newDeps!.push(kept);
    } else {
      sub.newDeps!.push({ node, seen });
      node.subs.push(sub);
    }
  }

  private isLive(sub: ModelComputation, node: ModelSignal | ModelComputation) {
    return !sub.newDeps || sub.newDeps.some((d) => d.node === node);
  }

  private hasObservers(node: ModelComputation) {
    return node.subs.some(
      (sub) =>
        this.isLive(sub, node) && !(this.af18 && sub.newDeps?.find((d) => d.node === node)?.written)
    );
  }

  // A write: readers that were up to date are marked and queued (an
  // immediate effect to run at the end of the write, or of the outermost
  // batch; an effect to the flush), a running reader is left to finish; then
  // the immediate effects run, then the flush is scheduled, if one is wanted.
  private notify(atom: ModelSignal | ModelComputation, comparable: boolean) {
    this.writes++;
    for (const sub of atom.subs) {
      if (!this.isLive(sub, atom)) continue;
      if (sub.running) {
        sub.invalidated = comparable && sub.invalidated !== STALE ? PENDING : STALE;
        if (sub.kind === "effect") sub.newDeps!.find((d) => d.node === atom)!.written = true;
      } else {
        if (sub.state === CLEAN || sub.forward) {
          if (sub.kind === "computed") {
            this.markDownstream(sub);
          } else {
            this.enqueue(sub);
          }
        }
        sub.state = comparable && sub.state !== STALE ? PENDING : STALE;
      }
      if (sub.kind === "computed" && sub.subs.length === 0) this.queueDisposal(sub);
    }
    if (this.immediates.length && !this.batchDepth) {
      const toRun = this.immediates;
      this.immediates = [];
      this.updateEach(toRun);
    }
    if (this.af18 ? !this.flushScheduled : this.flushWanted && !this.flushScheduled) {
      this.scheduleFlush();
    }
  }

  private enqueue(effect: ModelComputation) {
    if (effect.immediate) {
      this.immediates.push(effect);
    } else {
      this.observers.push(effect);
      this.flushWanted = true;
    }
  }

  // A write walks the readers that were up to date (each once), and through
  // an out-of-date computed only if it forwards the write.
  private markDownstream(computed: ModelComputation) {
    computed.forward = false;
    const stack = [computed];
    let current: ModelComputation | undefined;
    while ((current = stack.pop())) {
      for (const sub of current.subs) {
        if (sub.kind === "computed" && sub.subs.length === 0) this.queueDisposal(sub);
        if (!this.isLive(sub, current)) continue;
        if (sub.running || sub.state !== CLEAN) {
          if (sub.forward) {
            sub.forward = false;
            stack.push(sub);
          } else if (sub.running) {
            sub.invalidated = Math.max(sub.invalidated, PENDING);
          }
          continue;
        }
        sub.state = PENDING;
        if (sub.kind === "computed") {
          stack.push(sub);
        } else {
          this.enqueue(sub);
        }
      }
    }
  }

  // A flush is wanted for a disposal not queued yet (the flush that will
  // handle one already queued is enough).
  private queueDisposal(computed: ModelComputation) {
    if (this.disposals.has(computed)) return;
    this.disposals.add(computed);
    this.flushWanted = true;
  }

  private scheduleFlush() {
    this.flushScheduled = true;
    this.flushWanted = false;
    this.queue.push(() => this.flush());
  }

  private flush() {
    this.trace(`flush ${this.observers.map((o) => o.name)}`);
    this.flushScheduled = false;
    this.flushWanted = false;
    const pending = this.observers;
    this.observers = [];
    this.updateEach(pending);
    if (this.disposals.size) {
      const candidates = this.disposals;
      this.disposals = new Set();
      for (const computed of candidates) {
        if (!this.hasObservers(computed)) this.disposeComputed(computed);
      }
    }
  }

  private updateEach(list: ModelComputation[]) {
    for (const computation of list) {
      this.updateOwnerFirst(computation);
    }
  }

  // Owners that are due run before the effect they own (their re-run
  // disposes it); an effect owner only for an effect of its own kind, and
  // not one whose sources are being checked (it may not run).
  private updateOwnerFirst(computation: ModelComputation) {
    while (computation.state !== CLEAN) {
      let first: ModelComputation | null = null;
      for (let owner = computation.owner; owner; owner = owner.owner) {
        if (
          owner.state !== CLEAN &&
          !owner.running &&
          !owner.checking &&
          (owner.kind === "computed" || owner.immediate === computation.immediate)
        ) {
          first = owner;
        }
      }
      this.update(first ?? computation);
      if (!first) break;
      if (this.af18) {
        this.update(computation);
        break;
      }
    }
  }

  // Bringing a computed up to date is a batch: the immediate effects a write
  // or a change queues meanwhile run once the outermost computed is up to
  // date (for a read, once the reader holds it), never in the middle of an
  // evaluation they could read; what they write then reaches the reader as
  // any later write does.
  private batched(fn: () => void) {
    this.batchDepth++;
    try {
      fn();
    } finally {
      if (--this.batchDepth === 0 && this.immediates.length) {
        const toRun = this.immediates;
        this.immediates = [];
        this.updateEach(toRun);
      }
    }
  }

  private read(node: ModelComputation) {
    if (node.state === CLEAN) {
      this.track(node);
    } else {
      this.batched(() => {
        this.update(node);
        this.track(node);
      });
    }
  }

  private update(computation: ModelComputation) {
    if (computation.running) throw new Error("Cycle detected (model)");
    if (computation.state === CLEAN) return;
    if (computation.kind === "effect") {
      this.refresh(computation);
    } else {
      this.batched(() => this.refresh(computation));
    }
  }

  // A pending computation runs only if a source changed from what it read.
  private refresh(computation: ModelComputation) {
    if (computation.state === PENDING) {
      const writes = this.writes;
      computation.checking = true;
      try {
        this.checkSources(computation);
      } finally {
        computation.checking = false;
      }
      if (computation.state !== STALE) {
        computation.state = CLEAN;
        computation.forward = false;
        // a source a write put out of date during the check forwards the
        // next write to it
        if (writes !== this.writes) this.forwardPendingSources(computation);
        return;
      }
    }
    this.run(computation);
  }

  // Its sources in the order it read them, computeds brought up to date on
  // the way: the first change makes it STALE.
  private checkSources(computation: ModelComputation) {
    for (let i = 0; i < computation.deps.length; i++) {
      const dep = computation.deps[i];
      const node = dep.node;
      if (node.kind === "signal") {
        if (!Object.is(dep.seen, node.value)) {
          computation.state = STALE;
          return;
        }
        continue;
      }
      this.update(node);
      // a reader the check ran may have run it already (up to date), or the
      // check goes on from that source in what that run read
      if (computation.state !== PENDING) return;
      i = Math.max(i, computation.deps.indexOf(dep));
    }
  }

  private run(computation: ModelComputation) {
    this.trace(`run ${computation.name}`);
    computation.state = CLEAN;
    computation.forward = false;
    computation.invalidated = CLEAN;
    computation.running = true;
    if (computation.kind === "computed" && computation.owned.length) {
      this.unowned(() => this.disposeOwned(computation));
    }
    const tracking = this.tracking;
    this.tracking = computation;
    computation.newDeps = [];
    try {
      computation.fn();
    } finally {
      this.tracking = tracking;
      this.endTracking(computation);
      computation.running = false;
      // A computed that a write reached while it ran ends out of date: its
      // next read checks again what it read (or recomputes, STALE), and it
      // forwards the next write; an effect ends up to date, keeping the
      // values it read. Either way, the out-of-date computeds it read
      // forward the next write to it.
      computation.state = CLEAN;
      if (computation.invalidated !== CLEAN) {
        if (computation.kind === "computed") {
          computation.state = computation.invalidated;
          computation.forward = true;
        }
        this.forwardPendingSources(computation);
      }
    }
    if (computation.changed) {
      computation.changed = false;
      this.unowned(() => this.notify(computation, false));
    }
  }

  private forwardPendingSources(computation: ModelComputation) {
    const stack = [computation];
    let current: ModelComputation | undefined;
    while ((current = stack.pop())) {
      for (const { node } of current.deps) {
        if (node.kind === "computed" && node.state !== CLEAN && !node.forward) {
          node.forward = true;
          stack.push(node);
        }
      }
    }
  }

  private endTracking(computation: ModelComputation) {
    const kept = computation.newDeps!;
    for (const dep of kept) dep.written = false;
    for (const dep of computation.deps) {
      if (kept.some((d) => d.node === dep.node)) continue;
      const node = dep.node;
      removeSub(node, computation);
      if (node.kind === "computed" && node.subs.length === 0) {
        // unread: disposed at the flush, which it schedules
        this.queueDisposal(node);
        if (!this.flushScheduled) this.scheduleFlush();
      }
    }
    computation.deps = kept;
    computation.newDeps = null;
  }

  // During a run, what it read again comes first, then what it has not.
  private removeSources(computation: ModelComputation) {
    const read = computation.newDeps;
    const deps = read
      ? [...read, ...computation.deps.filter((d) => !read.some((r) => r.node === d.node))]
      : computation.deps;
    // a source not released yet still has it as a reader
    for (const dep of deps) {
      const node = dep.node;
      removeSub(node, computation);
      if (node.kind === "computed" && !node.running && !this.hasObservers(node)) {
        this.disposeComputed(node);
      }
    }
    computation.deps = [];
    if (read) computation.newDeps = [];
  }

  private disposeComputed(computed: ModelComputation) {
    this.trace(`dispose ${computed.name}`);
    this.removeSources(computed);
    computed.state = STALE;
    computed.forward = false;
    if (computed.owned.length) this.unowned(() => this.disposeOwned(computed));
  }

  private disposeOwned(computation: ModelComputation) {
    const owned = computation.owned;
    computation.owned = [];
    for (const child of owned) this.disposeEffect(child);
  }

  // Children first, then the effect's own cleanup.
  private release(effect: ModelComputation) {
    this.disposeOwned(effect);
    const cleanup = effect.value as (() => void) | undefined;
    effect.value = undefined;
    cleanup?.();
  }

  private disposeEffect(effect: ModelComputation) {
    this.trace(`dispose ${effect.name}`);
    effect.disposed = true;
    if (effect.owner) {
      const siblings = effect.owner.owned;
      const index = siblings.indexOf(effect);
      if (index >= 0) siblings.splice(index, 1);
      effect.owner = null;
    }
    effect.state = CLEAN;
    this.detach(effect);
  }

  private detach(effect: ModelComputation) {
    this.removeSources(effect);
    if (typeof effect.value === "function" || effect.owned.length) {
      this.unowned(() => this.release(effect));
    }
  }
}

function removeSub(node: ModelSignal | ModelComputation, sub: ModelComputation) {
  const index = node.subs.indexOf(sub);
  if (index < 0) throw new Error(`model: ${sub.name} is not a reader of what it read`);
  node.subs.splice(index, 1);
}

// ---------------------------------------------------------------------------
// Minimizing and printing

function* bodyVariants(ops: Op[]): Generator<Op[]> {
  for (let i = 0; i < ops.length; i++) {
    yield [...ops.slice(0, i), ...ops.slice(i + 1)];
  }
  for (let i = 0; i < ops.length; i++) {
    for (const op of opVariants(ops[i])) {
      yield [...ops.slice(0, i), op, ...ops.slice(i + 1)];
    }
  }
}

function* opVariants(op: Op): Generator<Op> {
  switch (op.op) {
    case "branch":
      yield { op: "read", ref: op.ref };
      for (const then of bodyVariants(op.then)) yield { ...op, then };
      for (const otherwise of bodyVariants(op.else)) yield { ...op, else: otherwise };
      break;
    case "untrack":
    case "batch":
    case "microtask":
      if (op.op !== "microtask") yield* op.body;
      for (const body of bodyVariants(op.body)) yield { ...op, body };
      break;
    case "effect": {
      const spec = op.spec;
      if (spec.detached) yield { op: "effect", spec: { ...spec, detached: false } };
      if (spec.cleanup) yield { op: "effect", spec: { ...spec, cleanup: false } };
      if (spec.immediate) yield { op: "effect", spec: { ...spec, immediate: false } };
      for (const body of bodyVariants(spec.body)) yield { op: "effect", spec: { ...spec, body } };
      break;
    }
    case "write":
      if ("acc" in op.value) yield { ...op, value: { k: 0 } };
      break;
  }
}

function* programVariants(program: Program): Generator<Program> {
  for (const steps of bodyVariants(program.steps)) {
    yield { ...program, steps };
  }
  for (let i = 0; i < program.computeds.length; i++) {
    const spec = program.computeds[i];
    const at = (next: ComputedSpec) => {
      const computeds = program.computeds.slice();
      computeds[i] = next;
      return { ...program, computeds };
    };
    if (spec.output !== null) yield at({ ...spec, output: null });
    for (const body of bodyVariants(spec.body)) yield at({ ...spec, body });
  }
}

// Greedy reduction: keep any one-step simplification that still fails.
export async function minimize(
  program: Program,
  fails: (program: Program) => Promise<boolean>
): Promise<Program> {
  let current = program;
  let improved = true;
  while (improved) {
    improved = false;
    for (const candidate of programVariants(current)) {
      if (await fails(candidate)) {
        current = candidate;
        improved = true;
        break;
      }
    }
  }
  return current;
}

function printRef(ref: Ref): string {
  return "s" in ref ? `s${ref.s}()` : "o" in ref ? `o${ref.o}()` : `c${ref.c}()`;
}

function printBody(ops: Op[], indent: string): string[] {
  const lines: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "read":
        lines.push(`${indent}${printRef(op.ref)};`);
        break;
      case "branch":
        lines.push(`${indent}if (${printRef(op.ref)} % 2) {`);
        lines.push(...printBody(op.then, indent + "  "));
        if (op.else.length) {
          lines.push(`${indent}} else {`);
          lines.push(...printBody(op.else, indent + "  "));
        }
        lines.push(`${indent}}`);
        break;
      case "untrack":
      case "batch":
        lines.push(`${indent}${op.op}(() => {`);
        lines.push(...printBody(op.body, indent + "  "));
        lines.push(`${indent}});`);
        break;
      case "microtask":
        lines.push(`${indent}Promise.resolve().then(() => {`);
        lines.push(...printBody(op.body, indent + "  "));
        lines.push(`${indent}});`);
        break;
      case "write":
        lines.push(
          `${indent}s${op.s}.set(${"k" in op.value ? op.value.k : `(sum of values read + ${op.value.acc}) % ${VALUES}`});`
        );
        break;
      case "effect": {
        const spec = op.spec;
        const options = spec.detached ? ", { detached: true }" : "";
        lines.push(`${indent}${spec.immediate ? "immediateEffect" : "effect"}(() => {`);
        lines.push(...printBody(spec.body, indent + "  "));
        if (spec.cleanup) lines.push(`${indent}  return cleanup;`);
        lines.push(`${indent}}${options});`);
        break;
      }
      case "dispose":
        lines.push(`${indent}dispose(effect #${op.pick} mod effects created);`);
        break;
      case "tick":
        lines.push(`${indent}await Promise.resolve();`);
        break;
    }
  }
  return lines;
}

export function printProgram(program: Program): string {
  const lines: string[] = [];
  const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  lines.push(
    `signals ${[...names("s", program.signals), ...names("o", program.outputs)].join(", ")} = 0`
  );
  program.computeds.forEach((spec, i) => {
    lines.push(`c${i} = computed(() => {`);
    lines.push(...printBody(spec.body, "  "));
    const value = `(sum of values read + ${i}) % ${spec.mod}`;
    if (spec.output !== null) lines.push(`  o${spec.output}.set(${value});`);
    lines.push(`  return ${value};`);
    lines.push("});");
  });
  lines.push(...printBody(program.steps, ""));
  return lines.join("\n");
}
