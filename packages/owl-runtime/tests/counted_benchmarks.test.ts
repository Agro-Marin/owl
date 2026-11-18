import { Component, mount, onWillPatch, props, proxy, xml } from "../src";
import { makeTestFixture, nextTick } from "./helpers";

// D.1 of the best-in-class plan: what an update costs, counted instead of
// timed, so a regression shows at any machine load. Each operation of a keyed
// 1000-row table (the js-framework-benchmark set) is held to the DOM
// mutations a MutationObserver records on the mounted tree and to the row
// renders it runs. The counts are exact: a change to one is a change to what
// OWL does, written down here with its reason.

interface Counts {
  added: number;
  removed: number;
  attributes: number;
  text: number;
  rowRenders: number;
}

let rowRenders = 0;
let nextId = 1;

function buildRows(count: number): { id: number; label: string }[] {
  return Array.from({ length: count }, () => {
    const id = nextId++;
    return { id, label: `row ${id}` };
  });
}

class Row extends Component {
  static template = xml`
    <tr t-att-class="{ danger: this.props.selected }">
      <td t-out="this.props.row.id"/>
      <td><a t-out="this.props.row.label"/></td>
    </tr>`;
  props = props();

  setup() {
    rowRenders++;
    onWillPatch(() => rowRenders++);
  }
}

class Table extends Component {
  static template = xml`
    <table><tbody>
      <t t-foreach="this.state.rows" t-as="row" t-key="row.id">
        <Row row="row" selected="row.id === this.state.selected"/>
      </t>
    </tbody></table>`;
  static components = { Row };
  state = proxy({ rows: [] as { id: number; label: string }[], selected: 0 });
}

async function counted(fixture: HTMLElement, operation: () => void): Promise<Counts> {
  const records: MutationRecord[] = [];
  // Records reach the callback in a microtask, before takeRecords() runs.
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(fixture, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  rowRenders = 0;
  operation();
  await nextTick();
  records.push(...observer.takeRecords());
  observer.disconnect();
  const counts: Counts = { added: 0, removed: 0, attributes: 0, text: 0, rowRenders };
  for (const record of records) {
    if (record.type === "childList") {
      counts.added += record.addedNodes.length;
      counts.removed += record.removedNodes.length;
    } else if (record.type === "attributes") {
      counts.attributes++;
    } else {
      counts.text++;
    }
  }
  return counts;
}

async function table(rows: number): Promise<{ fixture: HTMLElement; state: Table["state"] }> {
  nextId = 1;
  const fixture = makeTestFixture();
  const component = await mount(Table, fixture);
  if (rows) {
    component.state.rows = buildRows(rows);
    await nextTick();
  }
  return { fixture, state: component.state };
}

const ROWS = 1000;

const OPERATIONS: [string, number, (state: Table["state"]) => void, Counts][] = [
  [
    "create 1000 rows",
    0,
    (state) => (state.rows = buildRows(ROWS)),
    { added: 1000, removed: 0, attributes: 0, text: 0, rowRenders: 1000 },
  ],
  [
    "replace all 1000 rows",
    ROWS,
    (state) => (state.rows = buildRows(ROWS)),
    { added: 1000, removed: 1000, attributes: 0, text: 0, rowRenders: 1000 },
  ],
  [
    "update every 10th row's label",
    ROWS,
    (state) => {
      for (let i = 0; i < state.rows.length; i += 10) {
        state.rows[i].label += " !!!";
      }
    },
    { added: 0, removed: 0, attributes: 0, text: 100, rowRenders: 100 },
  ],
  [
    "select a row",
    ROWS,
    (state) => (state.selected = state.rows[500].id),
    { added: 0, removed: 0, attributes: 1, text: 0, rowRenders: 1 },
  ],
  [
    "swap rows 2 and 999",
    ROWS,
    (state) => {
      const rows = state.rows.slice();
      [rows[1], rows[998]] = [rows[998], rows[1]];
      state.rows = rows;
    },
    { added: 2, removed: 2, attributes: 0, text: 0, rowRenders: 0 },
  ],
  [
    "remove one row",
    ROWS,
    (state) => state.rows.splice(500, 1),
    { added: 0, removed: 1, attributes: 0, text: 0, rowRenders: 0 },
  ],
  [
    "append 1000 rows to 1000",
    ROWS,
    (state) => state.rows.push(...buildRows(ROWS)),
    { added: 1000, removed: 0, attributes: 0, text: 0, rowRenders: 1000 },
  ],
  [
    "clear 1000 rows",
    ROWS,
    (state) => (state.rows = []),
    // The list empties its parent in one textContent write and puts its
    // anchor back: one mutation record instead of 1000.
    { added: 1, removed: 1001, attributes: 0, text: 0, rowRenders: 0 },
  ],
];

test.each(OPERATIONS)("%s costs what it is budgeted", async (_, rows, operation, budget) => {
  const { fixture, state } = await table(rows);
  const counts = await counted(fixture, () => operation(state));
  console.debug("[owl:counted]", _, JSON.stringify(counts));
  expect(counts).toEqual(budget);
});
