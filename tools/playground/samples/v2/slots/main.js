import { Component, useState, mount } from "@odoo/owl";

class Card extends Component {
  static template = "Card";
  
  setup() {
    this.state = useState({ showContent: true });
  }

  toggleDisplay() {
    this.state.showContent = !this.state.showContent;
  }
}

class Counter extends Component {
  static template = "Counter";
  
  setup() {
    this.state = useState({val: 1});
  }

  inc() {
    this.state.val++;
  }
}

class Root extends Component {
  static template = "Root"
  static components = { Card, Counter };
  
  setup() {
    this.state = useState({a: 1, b: 3});
  }

  inc(key, delta) {
    this.state[key] += delta;
  }
}

mount(Root, document.body, { templates: TEMPLATES, dev: true});
