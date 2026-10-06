import { signal } from "@odoo/owl-core";
import { multi, type BDom, type MountTarget, type VNode } from "./blockdom";
import { Component } from "./component";
import type { ComponentNode } from "./component_node";
import { useEffect } from "./hooks";
import { onMounted, onWillDestroy } from "./lifecycle_hooks";
import { props } from "./props";
import { forwardErrorToParent } from "./rendering/error_handling";
import { STATUS } from "./status";
import { xml } from "./template_set";
import { types as t } from "./types";

// Internal component used as the sub-root — its sole job is to render the
// consumer's `default` slot so that descendant components are constructed and
// their onWillStart fires. Not exported.
class SuspenseHost extends Component {
  static template = xml`<t t-call-slot="default"/>`;

  setup() {
    this.__owl__.props.content.node = this.__owl__;
  }
}

// Where the content is in the DOM: the sub-root's nodes, then an anchor, which
// Suspense renders after its fallback - the same instance on every render, so
// a patch leaves it alone, and a list moving the Suspense, or inserting before
// it, moves or inserts around the content too.
class SuspenseContent implements VNode<SuspenseContent> {
  node: ComponentNode | null = null;
  anchor: Text | null = null;
  parent: MountTarget | null = null;

  mount(parent: MountTarget, afterNode: Node | null) {
    this.parent = parent;
    this.anchor = document.createTextNode("");
    parent.insertBefore(this.anchor, afterNode);
  }

  content(): BDom | null {
    const node = this.node;
    return node !== null && node.status === STATUS.MOUNTED ? node.bdom : null;
  }

  moveBeforeDOMNode(node: Node | null) {
    this.content()?.moveBeforeDOMNode(node);
    this.parent!.insertBefore(this.anchor!, node);
  }

  moveBeforeVNode(other: SuspenseContent | null, afterNode: Node | null) {
    this.moveBeforeDOMNode(other ? other.firstNode()! : afterNode);
  }

  patch() {}

  beforeRemove() {}

  // the content is removed by its root's destroy, from Suspense's onWillDestroy
  remove() {
    this.anchor!.remove();
  }

  firstNode(): Node {
    return this.content()?.firstNode() ?? this.anchor!;
  }
}

// Suspense renders only the `fallback` slot (under a `t-if`) and only for as
// long as the sub-root's render phase is pending. Once prepared and Suspense
// itself is mounted, the sub-root is mounted before the anchor of its
// SuspenseContent; flipping `prepared` then makes the `t-if` body disappear.
// Final DOM: [t-if anchor, sub-root, content anchor].
//
// For fully-synchronous subtrees, `prepared` is flipped during setup (see
// the fast-path check below), so the very first render skips the fallback
// — no flash.
export class Suspense extends Component {
  static template = xml`
    <t t-if="!this.prepared()">
      <t t-call-slot="fallback"/>
    </t>
  `;

  props = props({ slots: t.object({ default: t.any(), fallback: t.any().optional() }) });

  private prepared = signal(false);
  private mounted = signal(false);
  private subRootMounted = false;

  setup() {
    const suspenseNode = this.__owl__;
    const content = new SuspenseContent();
    const render = suspenseNode.renderFn;
    suspenseNode.renderFn = () => multi([render(), content]);
    // A sub-root renders the default slot independently of the enclosing
    // MountFiber — its willStart fires in parallel with the outer tree.
    const suspenseProps = this.props;
    const root = suspenseNode.app.createRoot(SuspenseHost, {
      props: {
        get slots() {
          return suspenseProps.slots;
        },
        content,
      },
      // Thread the plugin manager so `providePlugins` contributions from
      // ancestors are visible inside the default slot. (createRoot defaults
      // sub-roots to the app-level plugin manager; override here.) Destroy
      // cascade is handled explicitly below via `onWillDestroy`.
      pluginManager: suspenseNode.pluginManager,
      // Route errors from the sub-root back into Suspense's parent chain so
      // consumer `onError` handlers still catch descendant failures.
      onError: forwardErrorToParent(suspenseNode),
      // Let the scheduler see through the sub-root boundary, so renders of
      // the default slot yield to in-flight ancestor renders (e.g. a t-if
      // about to remove this Suspense).
      host: suspenseNode,
    } as any);

    // Kick off the render phase now — descendants' onWillStart fires in
    // parallel with the outer tree's mount, no target needed yet.
    root.prepare().then(() => this.prepared.set(true));

    // Sync fast path: if the sub-root's render phase finished synchronously
    // (no pending onWillStart in the subtree), flip `prepared` *now* so the
    // first render skips the fallback entirely — no flash.
    if (root.prepared) {
      this.prepared.set(true);
    }

    onMounted(() => this.mounted.set(true));

    // Mount the sub-root once the render phase has finished and Suspense is
    // in the DOM, before the anchor of its content (a ShadowRoot may be its
    // parent: not an element).
    useEffect(() => {
      if (this.subRootMounted || !this.prepared() || !this.mounted()) {
        return;
      }
      this.subRootMounted = true;
      root.mount(content.parent!, { afterNode: content.anchor });
    });

    onWillDestroy(() => root.destroy());
  }
}
