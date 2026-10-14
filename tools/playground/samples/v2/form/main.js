import { Component, useState, mount } from "@odoo/owl";

class Form extends Component {
  static template = "Form";

  setup() {
    this.state = useState({
      text: "",
      othertext: "",
      number: 11,
      color: "",
      bool: false
    });
  }
}

mount(Form, document.body, { templates: TEMPLATES, dev: true });
