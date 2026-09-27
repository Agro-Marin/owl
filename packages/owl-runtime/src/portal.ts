import { Signal } from "@odoo/owl-core";
import { Component } from "./component";
import { useEffect } from "./hooks";
import { onMounted, onWillDestroy } from "./lifecycle_hooks";
import { props } from "./props";
import { forwardErrorToParent } from "./rendering/error_handling";
import { xml } from "./template_set";
import { types as t } from "./types";

// Inner sub-root that simply renders the consumer's default slot. Module-level
// so its template is compiled once and shared across all Portal instances.
class PortalContent extends Component {
  static template = xml`<t t-call-slot="default"/>`;
}

export type PortalTarget = string | HTMLElement | Signal<HTMLElement | null> | null | undefined;

export class Portal extends Component {
  static template = xml``;

  props = props({
    slots: t.object(["default"]),
    target: t.or([t.string(), t.signal(t.instanceOf(HTMLElement)), t.instanceOf(HTMLElement)]),
  });

  setup() {
    const portalNode = this.__owl__;
    const app = portalNode.app;
    const portalProps = this.props;
    let root: ReturnType<typeof app.createRoot> | null = null;
    let mountedTarget: HTMLElement | null = null;

    const tearDown = () => {
      if (root) {
        root.destroy();
        root = null;
        mountedTarget = null;
      }
    };

    const mountInto = (target: HTMLElement, position?: "first-child") => {
      tearDown();
      root = app.createRoot(PortalContent, {
        props: {
          get slots() {
            return portalProps.slots;
          },
        },
        // Forward the plugin chain from this Portal (createRoot defaults
        // sub-roots to the app-level plugin manager) so `providePlugins`
        // contributions from ancestors are visible inside the portaled content.
        pluginManager: portalNode.pluginManager,
        // Route errors from the portaled subtree back through Portal's parent
        // chain so consumer `onError` handlers still catch them. Without this,
        // sub-root errors would propagate to app._handleError and tear down
        // the whole app.
        onError: forwardErrorToParent(portalNode),
        // Let the scheduler see through the sub-root boundary, so renders of
        // the portaled content yield to in-flight ancestor renders (e.g. a
        // t-if about to remove this Portal).
        host: portalNode,
      } as any);

      mountedTarget = target;
      root.mount(target, { position, allowDetached: true } as any);
    };

    useEffect(() => {
      const target = resolveTarget(this.props.target);
      if (!target) {
        return;
      }
      mountInto(target);
      return tearDown;
    });

    // a selector often names an element the same render creates (a dialog's
    // footer, a sibling's container): as t-portal did, it is looked up again
    // once the Portal is in the document, and the content goes first, before
    // what that render put there
    onMounted(() => {
      // the target found during setup may belong to what this render replaced
      if (
        root &&
        mountedTarget &&
        !mountedTarget.isConnected &&
        typeof this.props.target === "string"
      ) {
        tearDown();
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
