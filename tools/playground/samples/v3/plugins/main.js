import { Component, mount, onWillDestroy, usePlugin, Plugin, signal, xml } from "@odoo/owl";


class ClockPlugin extends Plugin {
    now = signal(new Date());

    setup() {
        const id = setInterval(() => this.now.set(new Date()), 1000);
        onWillDestroy(() => clearInterval(id));
    }
}

class DigitalClock extends Component {
    static template = xml`<div>🕒 <t t-out="this.clock.now().toLocaleTimeString()"/></div>`;
    clock = usePlugin(ClockPlugin);
}

class UTCClock extends Component {
    static template = xml`<div>🌍 UTC <t t-out="this.clock.now().toUTCString().slice(17, 25)"/></div>`;
    clock = usePlugin(ClockPlugin);
}

class Root extends Component {
    static components = { DigitalClock, UTCClock };
    static template = xml`
    <DigitalClock/>
    <UTCClock/>`;
}

mount(Root, document.body, { templates: TEMPLATES, plugins: [ClockPlugin], dev: true });
