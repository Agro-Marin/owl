import { renderToString, renderToBdom, snapshotEverything, makeTestFixture } from "../helpers";
import { mount } from "../../src/blockdom";
import { mount as mountComponent, Component, xml } from "../../src";

snapshotEverything();

describe("properly support svg", () => {
  test("add proper namespace to svg", () => {
    const template = `<svg width="100px" height="90px"><circle cx="50" cy="50" r="4" stroke="green" stroke-width="1" fill="yellow"/> </svg>`;
    expect(renderToString(template)).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100px" height="90px"><circle cx="50" cy="50" r="4" stroke="green" stroke-width="1" fill="yellow"></circle> </svg>`
    );
  });

  test("add proper namespace to g tags", () => {
    const template = `<g><circle cx="50" cy="50" r="4" stroke="green" stroke-width="1" fill="yellow"/> </g>`;
    expect(renderToString(template)).toBe(
      `<g xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="4" stroke="green" stroke-width="1" fill="yellow"></circle> </g>`
    );
  });

  test("namespace to g tags not added if already in svg namespace", () => {
    const template = `<svg><g/></svg>`;
    expect(renderToString(template)).toBe(`<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>`);
  });

  test("namespace to svg tags added even if already in svg namespace", () => {
    const template = `<svg><svg/></svg>`;
    const bdom = renderToBdom(template);
    const fixture = makeTestFixture();

    mount(bdom, fixture);
    const elems = fixture.querySelectorAll("svg");
    expect(elems.length).toEqual(2);
    for (const el of elems) {
      expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    }
  });

  test("svg namespace added to sub-blocks", () => {
    const template = `<svg><path t-if="path"/></svg>`;

    expect(renderToString(template, { path: false })).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg"></svg>`
    );
    expect(renderToString(template, { path: true })).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg"><path xmlns="http://www.w3.org/2000/svg"></path></svg>`
    );

    const bdom = renderToBdom(template, { path: true });
    const fixture = makeTestFixture();

    mount(bdom, fixture);
    const elems = fixture.querySelectorAll("svg, path");
    expect(elems.length).toEqual(2);
    for (const el of elems) {
      expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    }
  });

  test("svg namespace added to sub templates if root tag is path", async () => {
    const templates = `<t>
      <t t-name="svg"><svg><t t-call="path" /></svg></t>
      <t t-name="path"><path /></t>
    </t>
    `;
    const fixture = makeTestFixture();

    class Svg extends Component {
      static template = "svg";
    }

    await mountComponent(Svg, fixture, { templates });
    const elems = fixture.querySelectorAll("svg, path");
    expect(elems.length).toEqual(2);
    for (const el of elems) {
      expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    }
  });

  test("svg creates new block if it is within html", async () => {
    class Test extends Component {
      static template = xml`
        <div>
          <svg>
            <polygon fill="#000000" points="0 0 4 4 8 0" transform="translate(5 7)"/>
          </svg>
        </div>
      `;
    }
    const fixture = makeTestFixture();
    await mountComponent(Test, fixture);
    const elems = fixture.querySelectorAll("svg, polygon");
    expect(elems.length).toEqual(2);
    for (const el of elems) {
      expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    }
  });

  test("svg creates new block if it is within html -- 2", async () => {
    class Test extends Component {
      static template = xml`
        <div>
          <svg>
            <polygon fill="#000000" points="0 0 4 4 8 0" transform="translate(5 7)"/>
            <path t-if="this.hasPath" />
          </svg>
        </div>
      `;
      hasPath = true;
    }
    const fixture = makeTestFixture();
    await mountComponent(Test, fixture);
    const elems = fixture.querySelectorAll("svg, polygon, path");
    expect(elems.length).toEqual(3);
    for (const el of elems) {
      expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    }
  });

  test("an element given the xhtml namespace in an svg is an html element", () => {
    const template = `<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>x</p></div></foreignObject></svg>`;
    const fixture = makeTestFixture();
    mount(renderToBdom(template), fixture);
    expect(fixture.querySelector("foreignObject")!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(fixture.querySelector("div")!.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(fixture.querySelector("p")!.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  });

  test("a prefixed t-att name is set and removed in its namespace", () => {
    const XLINK = "http://www.w3.org/1999/xlink";
    const template = `<svg><use t-att="{ 'xlink:href': href }"/></svg>`;
    const fixture = makeTestFixture();
    const tree = renderToBdom(template, { href: "#a" });
    mount(tree, fixture);
    const use = fixture.querySelector("use")!;
    expect(use.getAttributeNS(XLINK, "href")).toBe("#a");
    tree.patch(renderToBdom(template, { href: false }), false);
    expect(use.hasAttributeNS(XLINK, "href")).toBe(false);
  });
});
