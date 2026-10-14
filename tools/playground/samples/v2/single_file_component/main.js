
import { Component, useState, xml, mount } from "@odoo/owl";

class Counter extends Component {
  static template = xml`
    <button t-on-click="() => state.value++">
      Click! [<t t-esc="state.value"/>]
    </button>`;

  state = useState({ value: 0 })
}

class Root extends Component {
  static template = xml`
    <div>
      <Counter/>
      <Counter/>
    </div>`;
  
  static components = { Counter };
}

mount(Root, document.body, { templates: TEMPLATES, dev: true});
