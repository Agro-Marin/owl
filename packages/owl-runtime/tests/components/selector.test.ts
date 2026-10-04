import { Component, mount, props, proxy, selector, xml } from "../../src";
import { makeTestFixture, nextTick, snapshotEverything, steps, useLogLifecycle } from "../helpers";

let fixture: HTMLElement;

snapshotEverything();

beforeEach(() => {
  fixture = makeTestFixture();
});

test("rows reading a selector render on a selection change only when their answer changed", async () => {
  let renders: number[] = [];
  class Row extends Component {
    static template = xml`<li t-att-class="{ on: this.props.isSelected(this.props.row.id) }" t-out="this.props.row.label"/>`;
    props = props();
    setup() {
      const render = this.__owl__.renderFn;
      this.__owl__.renderFn = () => {
        renders.push(this.props.row.id);
        return render();
      };
    }
  }
  class List extends Component {
    static template = xml`<ul><Row t-foreach="this.state.rows" t-as="row" t-key="row.id" row="row" isSelected="this.isSelected"/></ul>`;
    static components = { Row };
    state = proxy({ selected: 0, rows: [1, 2, 3, 4].map((id) => ({ id, label: `r${id}` })) });
    isSelected = selector(() => this.state.selected);
    setup() {
      useLogLifecycle(this);
    }
  }
  const list = await mount(List, fixture);
  steps.splice(0);
  renders = [];
  const selected = () => [...fixture.querySelectorAll(".on")].map((li) => li.textContent);
  list.state.selected = 2;
  await nextTick();
  expect(selected()).toEqual(["r2"]);
  expect(renders).toEqual([2]);
  list.state.selected = 4;
  await nextTick();
  expect(selected()).toEqual(["r4"]);
  expect(renders.sort()).toEqual([2, 2, 4]);
  // the list itself never rendered again
  expect(steps.splice(0)).toEqual([]);
  list.__owl__.app.destroy();
  steps.splice(0);
});
