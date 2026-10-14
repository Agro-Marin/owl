import { Signal } from "@odoo/owl-core";
import { createSubRoot } from "./app";
import { Component } from "./component";
import { useEffect } from "./hooks";
import { onMounted, onWillDestroy } from "./lifecycle_hooks";
import { props } from "./props";
import { forwardErrorToParent } from "./rendering/error_handling";
import { STATUS } from "./status";
import { ownTemplate } from "./template_set";
import { types as t } from "./types";

class PortalContent extends Component {
  static get template(): string {
    return ownTemplate(PortalContent, "PortalContent").xml`<t t-call-slot="default"/>`;
  }
}

export type PortalTarget = string | HTMLElement | Signal<HTMLElement | null> | null | undefined;

export class Portal extends Component {
  static get template(): string {
    return ownTemplate(Portal, "Portal").xml``;
  }

  props = props({
    slots: t.object(["default"]),
    target: t
      .or([
        t.string(),
        t.signal(t.instanceOf(HTMLElement)),
        t.instanceOf(HTMLElement),
        t.literal(null),
      ])
      .optional(),
  });

  setup() {
    const portalNode = this.__owl__;
    const app = portalNode.app;
    const portalProps = this.props;
    let root: ReturnType<typeof app.createRoot> | null = null;
    let mountedTarget: HTMLElement | null = null;
    let committed = false;

    const tearDown = () => {
      if (root) {
        root.destroy();
        root = null;
        mountedTarget = null;
      }
    };

    const mountInto = (target: HTMLElement, position?: "first-child") => {
      tearDown();
      root = createSubRoot(app, PortalContent, {
        props: {
          get slots() {
            return portalProps.slots;
          },
        },
        pluginManager: portalNode.pluginManager,
        onError: forwardErrorToParent(portalNode),
        host: portalNode,
      });

      mountedTarget = target;
      committed = false;
      if (portalNode.status === STATUS.MOUNTED) {
        commit(position);
      } else {
        root.prepare();
      }
    };

    const commit = (position?: "first-child") => {
      committed = true;
      root!.mount(mountedTarget!, { position, allowDetached: true });
    };

    useEffect(() => {
      const target = resolveTarget(this.props.target);
      if (!target) {
        return;
      }
      mountInto(target);
      return tearDown;
    });

    onMounted(() => {
      if (
        root &&
        mountedTarget &&
        !mountedTarget.isConnected &&
        typeof this.props.target === "string"
      ) {
        tearDown();
      }
      if (root && !committed) {
        commit();
      }
      if (!root && typeof this.props.target === "string") {
        const target = resolveTarget(this.props.target);
        if (target) {
          mountInto(target, "first-child");
        }
      }
    });

    onWillDestroy(tearDown);
  }
}

function resolveTarget(target: PortalTarget): HTMLElement | null {
  if (typeof target === "function") {
    target = (target as () => HTMLElement | null)();
  }
  if (typeof target === "string") {
    return document.querySelector<HTMLElement>(target);
  }
  if (target instanceof HTMLElement) {
    return target;
  }
  return null;
}
