import { signal } from "@odoo/owl-core";
import { createSubRoot } from "./app";
import { multi, type BDom, type MountTarget, type VNode } from "./blockdom";
import { Component } from "./component";
import type { ComponentNode } from "./component_node";
import { useEffect } from "./hooks";
import { onMounted, onWillDestroy } from "./lifecycle_hooks";
import { props } from "./props";
import { forwardErrorToParent } from "./rendering/error_handling";
import { STATUS } from "./status";
import { ownTemplate } from "./template_set";
import { types as t } from "./types";

class SuspenseHost extends Component {
  static get template(): string {
    return ownTemplate(SuspenseHost, "SuspenseHost").xml`<t t-call-slot="default"/>`;
  }

  setup() {
    this.__owl__.props.content.node = this.__owl__;
  }
}

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

  remove() {
    this.anchor!.remove();
  }

  firstNode(): Node {
    return this.content()?.firstNode() ?? this.anchor!;
  }
}

export class Suspense extends Component {
  static get template(): string {
    return ownTemplate(Suspense, "Suspense").xml`
    <t t-if="!this.prepared()">
      <t t-call-slot="fallback"/>
    </t>
  `;
  }

  props = props({ slots: t.object({ default: t.any(), fallback: t.any().optional() }) });

  private prepared = signal(false);
  private mounted = signal(false);
  private subRootMounted = false;

  setup() {
    const suspenseNode = this.__owl__;
    const content = new SuspenseContent();
    const render = suspenseNode.renderFn;
    suspenseNode.renderFn = () => multi([render(), content]);
    const suspenseProps = this.props;
    const root = createSubRoot(suspenseNode.app, SuspenseHost, {
      props: {
        get slots() {
          return suspenseProps.slots;
        },
        content,
      },
      pluginManager: suspenseNode.pluginManager,
      onError: forwardErrorToParent(suspenseNode),
      host: suspenseNode,
    });

    root.prepare().then(() => this.prepared.set(true));

    if (root.prepared) {
      this.prepared.set(true);
    }

    onMounted(() => this.mounted.set(true));

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
