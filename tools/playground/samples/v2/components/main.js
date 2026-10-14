import { Component, useState, mount } from "@odoo/owl";

class Greeter extends Component {
    static template = "Greeter";
    
    setup() {
        this.state = useState({ word: 'Hello' });
    }

    toggle() {
        this.state.word = this.state.word === 'Hi' ? 'Hello' : 'Hi';
    }
}

class Root extends Component {
    static components = { Greeter };
    static template = "Root"

    setup() {
        this.state = useState({ name: 'World'});
    }
}

mount(Root, document.body, { templates: TEMPLATES, dev: true });
