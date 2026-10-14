import { Component, mount, xml, signal } from "@odoo/owl";
import { Dialog } from "./dialog";


class Counter extends Component {
    static template = xml`<button t-on-click="this.increment" t-out="this.value()"/>`;
    
    value = signal(0);

    increment() {
        this.value.set(this.value() + 1);
    }
}

class Root extends Component {
    static components = { Dialog, Counter };
    static template = xml`
        <button t-on-click="() => this.toggle(true)">Show Dialog</button>
        <t t-if="this.showDialog()">
          <Dialog title="'Hello'" onClose="() => this.toggle(false)">
            <p>Some content here.</p>
            <p>Even a component: <Counter/></p>
            <t t-set-slot="footer">
              <em>Footer rendered in the parent's scope.</em>
            </t>
          </Dialog>
        </t>`;

    showDialog = signal(false);

    toggle(visible) {
        this.showDialog.set(visible);
    }
}

mount(Root, document.body, { templates: TEMPLATES, dev: true });
