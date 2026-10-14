const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function fixture(owl) {
  const target = document.createElement("section");
  document.body.append(target);
  const stats = { rows: 0, list: 0, root: 0, detail: 0, nested_renders: 0, render_ms: 0 };
  let renderDepth = 0;
  function instrument(component, name) {
    const render = component.__owl__.renderFn;
    component.__owl__.renderFn = () => {
      stats[name]++;
      const outermost = renderDepth++ === 0;
      if (!outermost) stats.nested_renders++;
      const start = outermost ? performance.now() : 0;
      try {
        return render();
      } finally {
        if (--renderDepth === 0) stats.render_ms += performance.now() - start;
      }
    };
  }
  class Row extends owl.Component {
    static template = owl.xml`<li t-att-data-id="this.props.row.id" t-att-class="{selected: this.props.choose(this.props.row.id)}" t-out="this.props.row.label"/>`;
    props = owl.props();
    setup() {
      instrument(this, "rows");
    }
  }
  class List extends owl.Component {
    static components = { Row };
    static template = owl.xml`<ul><Row t-foreach="this.props.rows" t-as="row" t-key="row.id" row="row" choose="this.choose"/></ul>`;
    props = owl.props();
    choose = owl.selector(() => this.props.selected());
    setup() {
      instrument(this, "list");
    }
  }
  class Detail extends owl.Component {
    static template = owl.xml`<article t-out="this.props.selected()"/>`;
    props = owl.props();
    setup() {
      instrument(this, "detail");
    }
  }
  class Root extends owl.Component {
    static components = { List, Detail };
    static template = owl.xml`<main><button data-action="select" t-on-click="this.select">Select</button><button data-action="update" t-on-click="this.update">Update</button><button data-action="navigate" t-on-click="this.navigate">Navigate</button><List t-if="this.screen() === 'list'" rows="this.rows" selected="this.selected"/><Detail t-else="" selected="this.selected"/></main>`;
    screen = owl.signal("list");
    selected = owl.signal(1);
    rows = owl.proxy(Array.from({ length: 200 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` })));
    updates = 0;
    setup() {
      instrument(this, "root");
    }
    select() {
      this.selected.set(this.selected() === 1 ? 2 : 1);
    }
    update() {
      this.updates++;
      for (let i = 0; i < this.rows.length; i += 10)
        this.rows[i].label = `row ${i + 1}:${this.updates}`;
    }
    navigate() {
      this.screen.set(this.screen() === "list" ? "detail" : "list");
    }
  }
  const app = new owl.App({ dev: false });
  let root;
  try {
    root = await app.createRoot(Root).mount(target);
  } catch (error) {
    app.destroy();
    target.remove();
    throw error;
  }

  function commit(action, ready) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`commit timed out: ${action}`));
      }, 5000);
      const observer = new MutationObserver(() => {
        if (!ready()) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      });
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      target.querySelector(`[data-action="${action}"]`).click();
    });
  }
  const selected = () => target.querySelector("li.selected")?.dataset.id;
  return {
    async run(name, repetitions) {
      const start = { ...stats };
      const time = performance.now();
      for (let i = 0; i < repetitions; i++) {
        if (name === "select_row") {
          const id = root.selected() === 1 ? "2" : "1";
          await commit("select", () => selected() === id);
        } else if (name === "update_20_rows") {
          const label = `row 1:${root.updates + 1}`;
          await commit("update", () => target.querySelector("li")?.textContent === label);
          for (let row = 0; row < 200; row += 10) {
            check(
              target.querySelector(`[data-id="${row + 1}"]`).textContent ===
                `row ${row + 1}:${root.updates}`,
              "updated row committed"
            );
          }
        } else {
          await commit(
            "navigate",
            () => target.querySelector("article")?.textContent === String(root.selected())
          );
          check(
            owl.observersOf(root.selected[owl.atomSymbol]).length === 1,
            "list selector released on navigation"
          );
          await commit("navigate", () => target.querySelectorAll("li").length === 200);
          check(selected() === String(root.selected()), "selection restored on return");
          check(
            owl.observersOf(root.selected[owl.atomSymbol]).length === 1,
            "only current list selector observes selection"
          );
        }
      }
      const result = Object.fromEntries(
        Object.keys(stats).map((key) => [key, (stats[key] - start[key]) / repetitions])
      );
      result.commit_ms = (performance.now() - time) / repetitions;
      check(
        result.rows === (name === "select_row" ? 2 : name === "update_20_rows" ? 20 : 200),
        "expected selective row rendering"
      );
      check(
        result.root === (name === "navigate_detail_and_back" ? 2 : 0),
        "expected root rendering"
      );
      return result;
    },
    dispose() {
      app.destroy();
      check(
        owl.observersOf(root.selected[owl.atomSymbol]).length === 0,
        "app releases selection observers"
      );
      target.remove();
    },
  };
}

export async function benchmarkNavigation(modules, rounds, repetitions) {
  const labels = modules.length === 2 ? ["baseline", "candidate"] : ["candidate"];
  const names = ["select_row", "update_20_rows", "navigate_detail_and_back"];
  const validation = {};
  for (let m = 0; m < modules.length; m++) {
    const owl = modules[m];
    let events = 0;
    const tail = [];
    owl.setDebugSink((channel, message) => {
      events++;
      tail.push(`${channel}: ${message}`);
      if (tail.length > 30) tail.shift();
    });
    owl.setDebug("reactivity,effect,computed,scope,scheduler,fiber,lifecycle,error,event");
    const app = await fixture(owl);
    try {
      validation[labels[m]] = {};
      for (const name of names) {
        validation[labels[m]][name] = await app.run(name, 2);
        console.debug(
          "[owl:navigation-validation]",
          labels[m],
          name,
          JSON.stringify({ ...validation[labels[m]][name], events, tail: [...tail] })
        );
      }
    } finally {
      app.dispose();
      owl.setDebug(false);
      owl.setDebugSink(null);
    }
  }
  const samples = {};
  for (const name of names) {
    const apps = [];
    try {
      for (const owl of modules) apps.push(await fixture(owl));
      for (const app of apps) await app.run(name, 3);
      const timings = modules.map(() => []);
      for (let round = 0; round < rounds; round++) {
        const order = modules.map((_, i) => i);
        if (round % 2) order.reverse();
        for (const m of order) timings[m].push(await apps[m].run(name, repetitions));
      }
      const medians = Object.fromEntries(
        labels.map((label, i) => [
          label,
          Object.fromEntries(
            Object.keys(timings[i][0]).map((key) => [
              key,
              median(timings[i].map((row) => row[key])),
            ])
          ),
        ])
      );
      samples[name] = {
        medians,
        samples: Object.fromEntries(labels.map((label, i) => [label, timings[i]])),
      };
      console.debug("[owl:navigation-timing]", name, JSON.stringify(medians));
    } finally {
      apps.forEach((app) => app.dispose());
    }
  }
  return {
    browser: navigator.userAgent,
    crossOriginIsolated,
    rounds,
    repetitions,
    validation,
    samples,
    limit:
      "Synthetic 200-row navigation app. commit_ms includes frame wait, effects, rendering, DOM commit and checks. render_ms sums nonoverlapping intervals in instrumented render functions, excluding the rest of the pipeline. It is not an Odoo workload.",
  };
}
