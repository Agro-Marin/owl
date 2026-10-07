import { StorePlugin } from "../store/store";

import { Component, useEffect, signal, plugin, props, types as t } from "@odoo/owl";

export class ContextMenu extends Component {
  static template = "devtools.ContextMenu";

  props = props({ items: t.array() });

  setup() {
    this.store = plugin(StorePlugin);
    this.contextMenu = signal(null);
    useEffect(() => {
      const position = this.store.contextMenu()?.position;
      const menu = this.contextMenu();
      if (!menu || !position) return;
      const menuWidth = menu.offsetWidth;
      const menuHeight = menu.offsetHeight;
      let { x, y } = position;
      if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth;
      }
      if (y + menuHeight > window.innerHeight) {
        y = window.innerHeight - menuHeight;
      }
      menu.style.left = x + "px";
      // Need 25px offset because of the main navbar from the browser devtools
      menu.style.top = y + "px";
    });
  }
  onClickItem(action) {
    action();
    this.store.contextMenu.set(null);
  }
}
