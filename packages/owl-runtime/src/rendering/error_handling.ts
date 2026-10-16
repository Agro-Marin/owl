import { debug, debugLog, isAbortError } from "@odoo/owl-core";
import type { ComponentNode } from "../component_node";
import { STATUS } from "../status";
import type { Fiber } from "./fibers";

export const fibersInError: WeakMap<Fiber, any> = new WeakMap();
export const nodeErrorHandlers: WeakMap<
  ComponentNode,
  ((error: any, finalize: Function) => void)[]
> = new WeakMap();

let handledBy: ComponentNode | null = null;

function invokeErrorHandlers(
  node: ComponentNode | null,
  error: any,
  finalize: Function
): { handled: boolean; error: any } {
  while (node) {
    const handlers = nodeErrorHandlers.get(node);
    if (handlers) {
      for (let i = handlers.length - 1; i >= 0; i--) {
        try {
          handlers[i](error, finalize);
          handledBy ||= node;
          return { handled: true, error };
        } catch (e) {
          error = e;
        }
      }
    }
    node = node.parent;
  }
  return { handled: false, error };
}

export function forwardErrorToParent(boundary: ComponentNode) {
  return (error: any, finalize: Function): void => {
    if (boundary.app.destroyed) {
      throw error;
    }
    const result = invokeErrorHandlers(boundary, error, finalize);
    if (!result.handled) {
      throw result.error;
    }
  };
}

type ErrorParams = { error: any } & ({ node: ComponentNode } | { fiber: Fiber });
export function handleError(params: ErrorParams) {
  const { error } = params;
  const node: ComponentNode | null = "node" in params ? params.node : params.fiber.node;
  const fiber = "fiber" in params ? params.fiber : node!.fiber;
  const app = node!.app;

  if (app.destroyed) {
    throw error;
  }

  if (fiber) {
    let current: Fiber | null = fiber;
    do {
      if (current.node.fiber === null) {
        current.node.fiber = current;
      }
      fibersInError.set(current, error);
      current = current.parent;
    } while (current);

    const root = fiber.root!;
    fibersInError.set(root, error);
    (root.failed ||= new Set()).add(fiber);
  }

  const finalize = () => {
    try {
      app.destroy();
    } catch {}
  };

  handledBy = null;
  const result = invokeErrorHandlers(node, error, finalize);
  if (debug.error) {
    debugLog(
      "error",
      result.handled && !app.destroyed
        ? `${node!.componentName}: error handled by ${handledBy === node ? "its own" : `${handledBy!.componentName}'s`} onError`
        : `${node!.componentName}: error not handled, the app is destroyed`,
      error
    );
  }
  if (!result.handled) {
    finalize();
    app._handleError(result.error);
  }
  if (fiber && fiber.root!.counter !== 0) {
    fiber.root!.node.app.scheduler.requestFrame();
  }
}

export function handleHookRejection(node: ComponentNode, fiber: Fiber, error: any) {
  if (node.fiber !== fiber) {
    if (debug.error) {
      debugLog(
        "error",
        `${node.componentName}: ${isAbortError(error) ? "abort" : "rejection"} dropped, ${node.status === STATUS.DESTROYED ? "destroyed" : "superseded"}`,
        error
      );
    }
    return;
  }
  handleError({ node, error });
}
