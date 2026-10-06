import { debug, debugLog, isAbortError } from "@odoo/owl-core";
import type { ComponentNode } from "../component_node";
import { STATUS } from "../status";
import type { Fiber } from "./fibers";

// Maps fibers to thrown errors
export const fibersInError: WeakMap<Fiber, any> = new WeakMap();
export const nodeErrorHandlers: WeakMap<
  ComponentNode,
  ((error: any, finalize: Function) => void)[]
> = new WeakMap();

// Walks up from `node` (inclusive), invoking the latest error handler at each
// level. Returns whether a handler caught and the final (possibly rethrown)
// error.
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

// Builds a sub-root error handler that re-routes errors to `boundary`'s
// parent chain. Used by Suspense/Portal so a descendant failure reaches the
// consumer's `onError` without the main `handleError` entry point (which
// would mark the outer tree's fibers as in-error and stall its mount).
export function forwardErrorToParent(boundary: ComponentNode) {
  return (error: any, finalize: Function): void => {
    if (boundary.app.destroyed) {
      throw error;
    }
    const result = invokeErrorHandlers(boundary, error, finalize);
    if (!result.handled) {
      finalize();
      boundary.app._handleError(result.error);
    }
  };
}

type ErrorParams = { error: any } & ({ node: ComponentNode } | { fiber: Fiber });
export function handleError(params: ErrorParams) {
  const { error } = params;
  const node: ComponentNode | null = "node" in params ? params.node : params.fiber.node;
  const fiber = "fiber" in params ? params.fiber : node!.fiber;
  const app = node!.app;

  // Once the app has been destroyed (e.g. by a prior unhandled error), stop
  // re-running error handling as the stack unwinds through ancestor renders.
  if (app.destroyed) {
    throw error;
  }

  if (fiber) {
    // resets the fibers on components if possible. This is important so that
    // new renderings can be properly included in the initial one, if any.
    let current: Fiber | null = fiber;
    do {
      current.node.fiber = current;
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
    } catch {
      // mute all errors here because we are in a corrupted state anyway
    }
  };

  const result = invokeErrorHandlers(node, error, finalize);
  if (debug.error) {
    debugLog(
      "error",
      result.handled
        ? `${node!.componentName}: error handled by an ancestor's onError`
        : `${node!.componentName}: error not handled, the app is destroyed`,
      error
    );
  }
  if (!result.handled) {
    finalize();
    app._handleError(result.error);
  }
  if (fiber && fiber.root!.counter !== 0) {
    // the pass may never finish: its scheduler, which holds the renders it
    // delayed, drops it at the next frame unless a handler re-rendered it
    fiber.root!.node.app.scheduler.requestFrame();
  }
}

// An onWillStart or onWillUpdateProps rejection, for `fiber`. Once the
// component is destroyed, or a newer render replaced that one, nobody waits for
// it: the error is dropped. It must not reach the living ancestors' handlers
// (they may have handled it already, through the instance it was created for,
// and rendered the instance this one was) nor tear the app down, nor surface as
// an unhandled rejection - an error dialog for work nobody consumes.
export function handleHookRejection(node: ComponentNode, fiber: Fiber, error: any) {
  if (node.fiber !== fiber) {
    if (debug.error) {
      debugLog(
        "error",
        `${node.componentName}: ${isAbortError(error) ? "abort" : "rejection"} ${node.status === STATUS.DESTROYED ? "after destroy" : "of a superseded render"}, dropped`,
        error
      );
    }
    return;
  }
  handleError({ node, error });
}
