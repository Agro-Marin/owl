import { batched, OwlError, Signal } from "@odoo/owl-core";
import { createSubRoot } from "./app";
import { Component } from "./component";
import type { ComponentNode } from "./component_node";
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
    position: t.number().optional(),
  });

  setup() {
    const portalNode = this.__owl__;
    const app = portalNode.app;
    const portalProps = this.props;
    let root: ReturnType<typeof app.createRoot> | null = null;
    let mountedTarget: HTMLElement | null = null;
    let committed = false;
    let rank: number | undefined;
    let placement: Placement | null = null;
    let placements: TargetPlacements | null = null;

    const tearDown = () => {
      const previous = root;
      root = null;
      mountedTarget = null;
      if (placement) {
        placements!.entries.delete(placement);
        placement = null;
        placements = null;
      }
      previous?.destroy();
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
      const mounting = root;
      mounting.promise.then(
        (component) => {
          if (root !== mounting) return;
          placements = targets.getOrInsertComputed(target, () => new TargetPlacements(target));
          placement = { node: component.__owl__, position: rank };
          // Register on mount, rather than creation, so equal ranks keep mount order.
          placements.entries.add(placement);
          placements.place();
        },
        () => {}
      );

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

    useEffect(() => {
      const nextRank = this.props.position;
      if (nextRank !== undefined && !Number.isFinite(nextRank)) {
        throw new OwlError("Portal position must be a finite number");
      }
      rank = nextRank;
      if (placement) {
        placement.position = rank;
        placements!.place();
      }
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

interface Placement {
  node: ComponentNode;
  position: number | undefined;
}

const targets = new WeakMap<HTMLElement, TargetPlacements>();

class TargetPlacements {
  entries = new Set<Placement>();

  constructor(private target: HTMLElement) {}

  place = batched(() => {
    const mounted = new Map<Node, Placement>();
    for (const entry of this.entries) {
      const first = entry.node.firstNode();
      if (entry.node.status === STATUS.MOUNTED && first?.parentNode === this.target) {
        mounted.set(first, entry);
      }
    }
    const ordered = [...mounted.values()].filter((entry) => entry.position !== undefined);
    ordered.sort((a, b) => a.position! - b.position!);
    if (!ordered.length) return;

    // Compare whole portals by their first nodes: a fragment's later roots must
    // not make a correctly placed portal move and lose its focused input.
    let index = 0;
    for (const node of this.target.childNodes) {
      const entry = mounted.get(node);
      if (!entry) continue;
      if (entry.position === undefined ? index > 0 : entry !== ordered[index++]) {
        for (const entry of ordered) entry.node.moveBeforeDOMNode(null);
        return;
      }
    }
  });
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
