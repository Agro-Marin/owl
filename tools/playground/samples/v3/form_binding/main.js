import { Component, signal, computed, mount, useEffect, proxy } from "@odoo/owl";


class Form extends Component {
    static template = "example.Form";

    text = signal("some text");
    number = signal(11);
    color = signal("");
    bool = signal(false);
    
    record = proxy({ name: "hello", amount: 3 });

    uppercaseText = computed(() => this.text().toUpperCase());

    amount = signal(2);
    doubleAmount = computed(() => 2 * this.amount(), {
        set: (v) => this.amount.set(v / 2),
    });

    setup() {
        useEffect(() => {
            console.log("text changed:", this.text());
        });
    }
}

mount(Form, document.body, { templates: TEMPLATES, dev: true });
