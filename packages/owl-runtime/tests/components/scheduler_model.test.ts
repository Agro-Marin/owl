import {
  App,
  Component,
  onError,
  onMounted,
  onPatched,
  onWillDestroy,
  onWillPatch,
  onWillStart,
  onWillUnmount,
  onWillUpdateProps,
  props,
  proxy,
  untrack,
} from "../../src";
import type { ComponentNode } from "../../src/component_node";
import { fibersInError } from "../../src/rendering/error_handling";
import { Scheduler } from "../../src/rendering/scheduler";
import { STATUS } from "../../src/status";
import { writeFileSync } from "fs";
import { setDebug, setDebugSink } from "@odoo/owl-core";
import { prng } from "../../../../tools/testing/helpers";

const COUNT = Number(process.env.OWL_SCHEDULER_MODEL || 300);
const FIRST_SEED = Number(process.env.OWL_SCHEDULER_MODEL_SEED || 1);
const STEPS = 30;
const TRACE = process.env.OWL_SCHEDULER_MODEL_TRACE;
let traceLines: string[] | null = null;

type ErrorMode = "none" | "rerender" | "quiet" | "rethrow";
type ChildKind = "static" | "if" | "foreach";
type Bomb = "render" | "willPatch" | "patched" | "willUpdateProps";
const BOMBS: Bomb[] = ["render", "willPatch", "patched", "willUpdateProps"];
const H = 0;
const F = 1;
const G = 2;
const APP_NAMES = ["H", "F", "G"];

interface ChildSpec {
  kind: ChildKind;
  def: number;
  key: string;
  propOf: "value" | "item" | "itemAndValue";
}

interface Def {
  id: number;
  tag: string;
  children: ChildSpec[];
  asyncStart: boolean;
  asyncUpdate: boolean;
  onError: ErrorMode;
  owner: number;
}

interface Spec {
  defs: Def[];
  shells: number[];
  mixed: boolean;
}

interface Step {
  kind: string;
  a: number;
  b: number;
}

interface Pending {
  label: string;
  resolve: () => void;
  reject: (e: Error) => void;
}

interface World {
  spec: Spec;
  state: any;
  armed: Set<string>;
  pending: Pending[];
  nodes: Set<ComponentNode>;
  logs: Map<ComponentNode, string[]>;
  labels: Map<ComponentNode, string>;
  renders: Map<ComponentNode, number>;
  unhandled: unknown[];
  fired: string[];
  serial: number;
}

const TAGS = ["div", "section", "span", "b"];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

function generate(random: () => number): Spec {
  const n = 3 + Math.floor(random() * 4);
  const defs: Def[] = [];
  for (let id = 0; id < n; id++) {
    const children: ChildSpec[] = [];
    const count = id === n - 1 ? 0 : Math.floor(random() * 3);
    for (let c = 0; c < count; c++) {
      const def = id + 1 + Math.floor(random() * (n - id - 1));
      const r = random();
      const kind: ChildKind = r < 0.4 ? "static" : r < 0.7 ? "if" : "foreach";
      children.push({
        kind,
        def,
        key: `k${id}_${c}`,
        propOf: kind === "foreach" ? pick(random, ["item", "itemAndValue"] as const) : "value",
      });
    }
    defs.push({
      id,
      tag: pick(random, TAGS),
      children,
      asyncStart: random() < 0.3,
      asyncUpdate: random() < 0.4,
      onError: random() < 0.3 ? pick(random, ["rerender", "quiet", "rethrow"] as const) : "none",
      owner: random() < 0.4 ? F : H,
    });
  }
  const shells: number[] = [];
  const roots = [0, Math.floor(random() * n), Math.floor(random() * n)];
  for (let app = H; app <= G; app++) {
    const id = defs.length;
    shells.push(id);
    defs.push({
      id,
      tag: "main",
      children: [{ kind: "static", def: roots[app], key: `shell${app}`, propOf: "value" }],
      asyncStart: false,
      asyncUpdate: false,
      onError:
        app === G
          ? pick(random, ["none", "rerender", "quiet", "rethrow"] as const)
          : pick(random, ["rerender", "quiet"] as const),
      owner: app,
    });
  }
  return { defs, shells, mixed: random() < 0.5 };
}

function childXml(def: Def, child: ChildSpec, index: number): string {
  const tag = `C${child.def}`;
  if (child.kind === "static") {
    return `<${tag} p="this.w.v[${def.id}] + ${index}"/>`;
  }
  if (child.kind === "if") {
    return `<${tag} t-if="this.w.show.${child.key}" p="this.w.v[${def.id}]"/>`;
  }
  const p = child.propOf === "item" ? "x" : `x * 10 + this.w.v[${def.id}]`;
  return `<t t-foreach="this.w.items.${child.key}" t-as="x" t-key="x"><${tag} p="${p}"/></t>`;
}

function templateOf(def: Def): string {
  const children = def.children.map((c, i) => childXml(def, c, i)).join("");
  return `<${def.tag}><t t-out="this.props.p"/>:<t t-out="this.w.v[${def.id}]"/>:<t t-out="this.w.errs[${def.id}]"/>${children}<t t-out="this.bomb()"/></${def.tag}>`;
}

function describeSpec(spec: Spec): string {
  return spec.defs
    .map((d) => {
      const flags = [
        `app ${APP_NAMES[d.owner]}`,
        d.asyncStart && "async willStart",
        d.asyncUpdate && "async willUpdateProps",
        d.onError !== "none" && `onError ${d.onError}`,
      ].filter(Boolean);
      const name = spec.shells.includes(d.id) ? `Shell${APP_NAMES[spec.shells.indexOf(d.id)]}` : "";
      return `\n  C${d.id}${name ? ` (${name})` : ""} [${flags.join(", ")}]: ${templateOf(d)}`;
    })
    .join("");
}

function initialState(spec: Spec) {
  const show: Record<string, boolean> = {};
  const items: Record<string, number[]> = {};
  for (const def of spec.defs) {
    for (const child of def.children) {
      if (child.kind === "if") {
        show[child.key] = true;
      } else if (child.kind === "foreach") {
        items[child.key] = [1, 2];
      }
    }
  }
  return {
    v: spec.defs.map(() => 0),
    errs: spec.defs.map(() => 0),
    show,
    items,
    next: 3,
  };
}

function makeClasses(world: World, reference: boolean) {
  const components: Record<string, any> = {};
  const classes: any[] = [];
  for (const def of world.spec.defs) {
    const name = `C${def.id}`;
    const C = class extends Component {
      static template = name;
      static components = components;
      props = props();
      get w() {
        return world.state;
      }
      bomb() {
        if (!reference && world.armed.delete(`render:${def.id}`)) {
          world.fired.push(`render:${def.id}`);
          throw new Error(`render bomb ${name}`);
        }
        return "";
      }
      setup() {
        if (!reference) {
          setupTracked(world, this.__owl__, def);
        }
      }
    };
    Object.defineProperty(C, "name", { value: name });
    components[name] = C;
    classes.push(C);
  }
  return classes;
}

function setupTracked(world: World, node: ComponentNode, def: Def) {
  const label = `C${def.id}#${++world.serial}`;
  const log: string[] = ["setup"];
  world.nodes.add(node);
  world.logs.set(node, log);
  world.labels.set(node, label);
  const render = node.renderFn;
  node.renderFn = () => {
    world.renders.set(node, (world.renders.get(node) || 0) + 1);
    return render();
  };
  const deferred = (what: string) =>
    new Promise<void>((resolve, reject) => {
      world.pending.push({ label: `${label} ${what}`, resolve, reject });
    });
  const fire = (bomb: Bomb) => {
    if (world.armed.delete(`${bomb}:${def.id}`)) {
      world.fired.push(`${bomb}:${def.id}`);
      throw new Error(`${bomb} bomb ${label}`);
    }
  };
  if (def.asyncStart) {
    onWillStart(async () => {
      log.push("willStart");
      await deferred("willStart");
      if (node.status !== STATUS.DESTROYED) {
        log.push("started");
      }
    });
  }
  onWillUpdateProps(() => {
    log.push("willUpdateProps");
    fire("willUpdateProps");
    return def.asyncUpdate ? deferred("willUpdateProps") : undefined;
  });
  onMounted(() => log.push("mounted"));
  onWillPatch(() => {
    log.push("willPatch");
    fire("willPatch");
  });
  onPatched(() => {
    log.push("patched");
    fire("patched");
  });
  onWillUnmount(() => log.push("willUnmount"));
  onWillDestroy(() => log.push("destroy"));
  if (def.onError !== "none") {
    onError((error) => {
      log.push("error");
      if (def.onError === "rethrow") {
        throw error;
      }
      if (def.onError === "rerender") {
        untrack(() => world.state.errs[def.id]++);
      }
    });
  }
}

function makeApp(): App {
  const app = new App({ test: true });
  app.scheduler.requestAnimationFrame = (cb) => setImmediate(() => cb(0)) as any;
  return app;
}

const INJECTED = /^(render|willPatch|patched|willUpdateProps) bomb |^rejected /;

async function frames(n: number) {
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function settle(world: World): Promise<boolean> {
  for (let round = 0; round < 100; round++) {
    await frames(4);
    if (!world.pending.length) {
      await frames(4);
      if (!world.pending.length) {
        return true;
      }
    }
    while (world.pending.length) {
      world.pending.shift()!.resolve();
    }
  }
  return false;
}

function generateSteps(random: () => number): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < STEPS; i++) {
    const r = random();
    const kind =
      r < 0.22
        ? "write"
        : r < 0.3
          ? "show"
          : r < 0.4
            ? "items"
            : r < 0.48
              ? "bomb"
              : r < 0.68
                ? "resolve"
                : r < 0.8
                  ? "micro"
                  : r < 0.94
                    ? "frame"
                    : r < 0.96
                      ? "deep"
                      : r < 0.98
                        ? "destroyG"
                        : "destroyH";
    steps.push({ kind, a: random(), b: random() });
  }
  return steps;
}

function liveNodes(world: World): ComponentNode[] {
  return [...world.nodes].filter((n) => n.status === STATUS.MOUNTED);
}

async function runStep(world: World, step: Step, ctx: Ctx): Promise<string | null> {
  const { spec, state } = world;
  const n = spec.defs.length;
  switch (step.kind) {
    case "write": {
      const id = Math.floor(step.a * n);
      const value = Math.floor(step.b * 4);
      state.v[id] = value;
      return `v[${id}]=${value}`;
    }
    case "show": {
      const keys = Object.keys(state.show);
      if (!keys.length) return null;
      const key = keys[Math.floor(step.a * keys.length)];
      state.show[key] = !state.show[key];
      return `show.${key}=${state.show[key]}`;
    }
    case "items": {
      const keys = Object.keys(state.items);
      if (!keys.length) return null;
      const key = keys[Math.floor(step.a * keys.length)];
      const list = state.items[key];
      if (step.b < 0.4 || !list.length) {
        list.push(state.next++);
        return `items.${key} push`;
      }
      if (step.b < 0.75) {
        list.splice(Math.floor(((step.b - 0.4) / 0.35) * list.length), 1);
        return `items.${key} remove`;
      }
      list.reverse();
      return `items.${key} reverse`;
    }
    case "bomb": {
      const id = Math.floor(step.a * n);
      const bomb = BOMBS[Math.floor(step.b * BOMBS.length)];
      world.armed.add(`${bomb}:${id}`);
      return `arm ${bomb} C${id}`;
    }
    case "resolve": {
      if (!world.pending.length) return null;
      const [p] = world.pending.splice(Math.floor(step.a * world.pending.length), 1);
      if (step.b < 0.1) {
        world.fired.push(`reject ${p.label}`);
        p.reject(new Error(`rejected ${p.label}`));
        return `reject ${p.label}`;
      }
      p.resolve();
      return `resolve ${p.label}`;
    }
    case "micro":
      await Promise.resolve();
      return "microtask";
    case "frame":
      await frames(1);
      return "frame";
    case "deep": {
      const live = liveNodes(world);
      if (!live.length) return null;
      const node = live[Math.floor(step.a * live.length)];
      node.render(true);
      return `deep render ${world.labels.get(node)}`;
    }
    case "destroyG": {
      if (ctx.apps[G].destroyed) return null;
      ctx.apps[G].destroy();
      ctx.destroyedByStep.add(G);
      return "destroy app G";
    }
    case "destroyH": {
      if (spec.mixed || ctx.apps[H].destroyed) return null;
      ctx.apps[H].destroy();
      ctx.destroyedByStep.add(H);
      return "destroy app H";
    }
  }
  return null;
}

interface Ctx {
  apps: App[];
  hosts: HTMLElement[];
  destroyedByStep: Set<number>;
}

function schedulerProblems(world: World, ctx: Ctx, stage: string, strict = false): string[] {
  const problems: string[] = [];
  ctx.apps.forEach((app, i) => {
    const s = app.scheduler;
    if (!app.destroyed && s.tasks.size) {
      const names = [...s.tasks].map(
        (f) => `${world.labels.get(f.node) || f.node.componentName} (counter ${f.counter})`
      );
      problems.push(`${stage}: app ${APP_NAMES[i]} keeps ${s.tasks.size} task(s): ${names}`);
    }
    if (!app.destroyed && s.delayedRenders.length) {
      const names = s.delayedRenders.map(
        (f) =>
          `${world.labels.get(f.node) || f.node.componentName} (status ${f.node.status}, ${f.node.fiber === f ? "current" : "stale"} fiber, app ${APP_NAMES[ctx.apps.indexOf(f.node.app)]})`
      );
      problems.push(
        `${stage}: app ${APP_NAMES[i]} keeps ${s.delayedRenders.length} delayed render(s): ${names}`
      );
    }
    if (Scheduler.active.has(s) && (app.destroyed || !s.tasks.size)) {
      problems.push(
        `${stage}: Scheduler.active holds app ${APP_NAMES[i]}'s scheduler (${app.destroyed ? "destroyed" : "no task"})`
      );
    }
  });
  for (const node of world.nodes) {
    const label = world.labels.get(node);
    if (node.status === STATUS.DESTROYED && node.fiber) {
      problems.push(`${stage}: destroyed ${label} keeps a fiber`);
    } else if (node.status === STATUS.MOUNTED && !node.app.destroyed && node.fiber) {
      const fiber = node.fiber;
      const root = fiber.root;
      const dropped = fibersInError.has(fiber) || (root !== null && fibersInError.has(root));
      if (strict || !dropped) {
        problems.push(
          `${stage}: mounted ${label} keeps a ${dropped ? "failed" : "pending"} fiber (${root ? `pass of ${world.labels.get(root.node) || root.node.componentName}, counter ${root.counter}` : "cancelled"})`
        );
      }
    }
  }
  return problems;
}

function lifecycleProblems(world: World, final: boolean): string[] {
  const problems: string[] = [];
  for (const [node, log] of world.logs) {
    const label = world.labels.get(node);
    let mounted = 0;
    let willPatch = 0;
    let patched = 0;
    let unmounted = 0;
    let destroyed = false;
    const def = world.spec.defs[Number(node.componentName.slice(1))];
    let started = !def.asyncStart;
    for (const entry of log) {
      if (destroyed) {
        problems.push(`${label}: ${entry} after onWillDestroy (${log})`);
        break;
      }
      switch (entry) {
        case "started":
          started = true;
          break;
        case "mounted":
          mounted++;
          if (!started) problems.push(`${label}: onMounted before onWillStart settled (${log})`);
          if (mounted > 1) problems.push(`${label}: onMounted twice (${log})`);
          break;
        case "willPatch":
          willPatch++;
          if (!mounted) problems.push(`${label}: onWillPatch before onMounted (${log})`);
          break;
        case "patched":
          patched++;
          if (!mounted) problems.push(`${label}: onPatched before onMounted (${log})`);
          if (patched > willPatch)
            problems.push(`${label}: onPatched without onWillPatch (${log})`);
          break;
        case "willUnmount":
          unmounted++;
          if (!mounted) problems.push(`${label}: onWillUnmount without onMounted (${log})`);
          if (unmounted > 1) problems.push(`${label}: onWillUnmount twice (${log})`);
          break;
        case "destroy":
          destroyed = true;
          break;
      }
    }
    if (final && destroyed && mounted && !unmounted) {
      problems.push(`${label}: destroyed after onMounted without onWillUnmount (${log})`);
    }
    if (final && node.status === STATUS.MOUNTED && !node.app.destroyed && !mounted) {
      problems.push(`${label}: mounted without onMounted (${log})`);
    }
  }
  return problems;
}

async function referenceHtml(world: World, shells: number[]): Promise<string[]> {
  const app = makeApp();
  const classes = makeClasses(world, true);
  for (const def of world.spec.defs) {
    app.addTemplate(`C${def.id}`, templateOf(def));
  }
  const container = document.body.appendChild(document.createElement("div"));
  const hosts = shells.map(() => container.appendChild(document.createElement("div")));
  await Promise.all(shells.map((id, i) => app.createRoot(classes[id]).mount(hosts[i])));
  const html = hosts.map((h) => h.innerHTML);
  app.destroy();
  container.remove();
  return html;
}

async function domProblems(world: World, ctx: Ctx, stage: string): Promise<string[]> {
  const live = [H, F, G].filter((i) => !ctx.apps[i].destroyed);
  const expected = await referenceHtml(
    world,
    live.map((i) => world.spec.shells[i])
  );
  const problems: string[] = [];
  live.forEach((app, i) => {
    const actual = ctx.hosts[app].innerHTML;
    if (actual !== expected[i]) {
      problems.push(`${stage}: app ${APP_NAMES[app]} DOM ${actual}\n    expected ${expected[i]}`);
    }
  });
  return problems;
}

interface Outcome {
  problems: string[];
  trace: string[];
  staleForce: string[];
}

async function runScenario(spec: Spec, steps: Step[]): Promise<Outcome> {
  const world: World = {
    spec,
    state: proxy(initialState(spec)),
    armed: new Set(),
    pending: [],
    nodes: new Set(),
    logs: new Map(),
    labels: new Map(),
    renders: new Map(),
    unhandled: [],
    fired: [],
    serial: 0,
  };
  const classes = makeClasses(world, false);
  const apps = [makeApp(), makeApp(), makeApp()];
  for (const def of spec.defs) {
    for (const app of apps) {
      app.addTemplate(`C${def.id}`, templateOf(def));
    }
  }
  for (const def of spec.defs) {
    const owner = apps[def.owner];
    const name = `C${def.id}`;
    if (def.owner === F) {
      apps[H].templates[name] = owner.getTemplate(name);
    } else if (def.owner === H && spec.mixed) {
      apps[F].templates[name] = owner.getTemplate(name);
    }
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const hosts = apps.map(() => container.appendChild(document.createElement("div")));
  const ctx: Ctx = { apps, hosts, destroyedByStep: new Set() };
  const onUnhandled = (error: unknown) => world.unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", onUnhandled);
  const trace: string[] = [];
  const problems: string[] = [];
  let staleForce: string[] = [];
  try {
    for (let i = H; i <= G; i++) {
      apps[i]
        .createRoot(classes[spec.shells[i]])
        .mount(hosts[i])
        .catch(() => {});
    }
    for (const step of steps) {
      const done = await runStep(world, step, ctx);
      if (done) {
        trace.push(done);
        traceLines?.push(`---- step: ${done}`);
      }
    }
    traceLines?.push("---- settle");
    if (!(await settle(world))) {
      problems.push("never settles: hooks keep awaiting");
    }
    problems.push(...schedulerProblems(world, ctx, "settled"));
    problems.push(...lifecycleProblems(world, false));
    const clean = !world.fired.length && !world.unhandled.length;
    if (clean) {
      problems.push(...(await domProblems(world, ctx, "settled")));
      if (!problems.length) {
        staleForce = await staleForceProblems(world, ctx);
      }
    }
    world.armed.clear();
    for (let i = H; i <= G; i++) {
      if (!apps[i].destroyed) {
        rootNode(world, apps[i], spec.shells[i])?.render(true);
      }
    }
    if (!(await settle(world))) {
      problems.push("never settles after the repair render");
    }
    problems.push(...schedulerProblems(world, ctx, "repaired", true));
    problems.push(...(await domProblems(world, ctx, "repaired")));
  } catch (error: any) {
    problems.push(`throws ${error?.stack || error}`);
  }
  const destroyedEarly = apps.map((app) => app.destroyed);
  for (const app of apps) {
    if (!app.destroyed) {
      try {
        app.destroy();
      } catch (error: any) {
        problems.push(`app.destroy throws ${error?.message}`);
      }
    }
  }
  for (const node of world.nodes) {
    if (node.status !== STATUS.DESTROYED) {
      problems.push(
        `${world.labels.get(node)} not destroyed with its app (status ${node.status}, fiber ${node.fiber ? "kept" : "none"}, ${world.logs.get(node)})`
      );
    }
  }
  problems.push(...schedulerProblems(world, ctx, "destroyed"));
  problems.push(...lifecycleProblems(world, true));
  await frames(2);
  process.off("unhandledRejection", onUnhandled);
  process.off("uncaughtException", onUnhandled);
  for (const error of world.unhandled) {
    const message = String((error as any)?.message ?? error);
    if (!INJECTED.test(message)) {
      problems.push(`unexpected error: ${(error as any)?.stack ?? message}`);
    }
  }
  for (const app of [H, F]) {
    if (destroyedEarly[app] && !ctx.destroyedByStep.has(app)) {
      problems.push(`app ${APP_NAMES[app]} destroyed by an error its shell should have handled`);
    }
  }
  container.remove();
  return { problems: [...new Set(problems)], trace, staleForce };
}

function rootNode(world: World, app: App, shell: number): ComponentNode | undefined {
  for (const node of world.nodes) {
    if (node.app === app && !node.parent && node.componentName === `C${shell}`) {
      return node;
    }
  }
  return undefined;
}

async function staleForceProblems(world: World, ctx: Ctx): Promise<string[]> {
  const flagged = liveNodes(world).filter((n) => n.forceNextRender && !n.app.destroyed);
  if (!flagged.length) {
    return [];
  }
  const before = new Map(world.renders);
  for (let i = H; i <= G; i++) {
    if (!ctx.apps[i].destroyed) {
      rootNode(world, ctx.apps[i], world.spec.shells[i])?.render(false);
    }
  }
  await settle(world);
  const extra = flagged.filter((n) => world.renders.get(n) !== before.get(n));
  return extra.map((n) => `${world.labels.get(n)} rendered again by an unchanged parent render`);
}

async function minimize(spec: Spec, steps: Step[]): Promise<{ steps: Step[]; outcome: Outcome }> {
  let current = steps;
  let outcome = await runScenario(spec, current);
  let chunk = Math.ceil(current.length / 2);
  while (chunk >= 1) {
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
      const result = await runScenario(spec, candidate);
      if (result.problems.length) {
        current = candidate;
        outcome = result;
        reduced = true;
        start -= chunk;
      }
    }
    if (!reduced) {
      chunk = Math.floor(chunk / 2);
    }
  }
  return { steps: current, outcome };
}

test(
  "random multi-app render scenarios drain every scheduler and settle on a fresh mount's DOM",
  async () => {
    const failures: string[] = [];
    const stale: string[] = [];
    for (let seed = FIRST_SEED; seed < FIRST_SEED + COUNT && failures.length < 3; seed++) {
      const random = prng(seed);
      const spec = generate(random);
      const steps = generateSteps(random);
      const outcome = await runScenario(spec, steps);
      if (outcome.staleForce.length) {
        stale.push(`seed ${seed}: ${outcome.staleForce.join("; ")}`);
      }
      if (!outcome.problems.length) {
        continue;
      }
      const minimal = await minimize(spec, steps);
      if (TRACE && !failures.length) {
        traceLines = [];
        setDebug("scheduler,fiber,lifecycle,error");
        setDebugSink((channel, message) => traceLines!.push(`[${channel}] ${message}`));
        const replay = await runScenario(spec, minimal.steps);
        setDebug(false);
        setDebugSink(null);
        writeFileSync(TRACE, [...traceLines, "", ...replay.problems].join("\n"));
        traceLines = null;
      }
      failures.push(
        `seed ${seed} (OWL_SCHEDULER_MODEL_SEED=${seed} OWL_SCHEDULER_MODEL=1)${spec.mixed ? ", templates shared both ways" : ""}:${describeSpec(spec)}\n  steps: ${minimal.outcome.trace.join(", ") || "(none)"}\n  ${minimal.outcome.problems.slice(0, 6).join("\n  ")}`
      );
    }
    expect(failures).toEqual([]);
    expect(stale).toEqual([]);
  },
  Math.max(120000, COUNT * 1000)
);
