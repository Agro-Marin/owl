import { Component, useState, mount, reactive, useEnv } from "@odoo/owl";


function debounce(func, wait, immediate) {
  let timeout;
  return function () {
    const context = this;
    const args = arguments;
    function later() {
      timeout = null;
      if (!immediate) {
        func.apply(context, args);
      }
    }
    const callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) {
      func.apply(context, args);
    }
  };
}


function createUI() {
  const getIsMobile = () => window.innerWidth <= 768;

  const ui = reactive({ isMobile: getIsMobile() });

    const updateEnv = debounce(() => {
      const isMobile = getIsMobile();
        if (ui.isMobile !== isMobile) {
            ui.isMobile = isMobile;
        }
    }, 15);
    window.addEventListener("resize", updateEnv);
    return ui;
}

function useUI() {
  const env = useEnv();
  return useState(env.ui);
}


class Navbar extends Component {
  static template = "Navbar";
}

class MobileSearchView extends Component {
  static template = "MobileSearchView";
}

class ControlPanel extends Component {
  static template = "ControlPanel";
  static components = { MobileSearchView };
  setup() {
    this.ui = useUI();
  }
}

class AdvancedComponent extends Component {
  static template = "AdvancedComponent";
}

class FormView extends Component {
  static template = "FormView";
  static components = { AdvancedComponent };
  setup() {
    this.ui = useUI();
  }
}

class Chatter extends Component {
    static template = "Chatter";

    setup() {
        this.messages = Array.from(Array(100).keys());
    }
}

class Root extends Component {
  static template = "Root";
  static components = { Navbar, ControlPanel, FormView, Chatter };

  setup() {
    this.ui = useUI();
  }
}



const env = {
  ui: createUI()
};

mount(Root, document.body, { templates: TEMPLATES, env, dev: true });
