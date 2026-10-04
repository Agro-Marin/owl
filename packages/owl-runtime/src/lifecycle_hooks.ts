import { ComponentNode, getComponentScope } from "./component_node";
import { nodeErrorHandlers } from "./rendering/error_handling";

// -----------------------------------------------------------------------------
//  hooks
// -----------------------------------------------------------------------------

export { onWillDestroy, onWillStart } from "@odoo/owl-core";

export function onWillUpdateProps(
  fn: (nextProps: any, scope: ComponentNode) => Promise<void> | void | any
) {
  const scope = getComponentScope();
  // decorate prepends scope as the first arg, but onWillUpdateProps's public
  // signature is (nextProps, scope) — swap back.
  function swapped(this: any, s: ComponentNode, nextProps: any) {
    return fn.call(this, nextProps, s);
  }
  scope.addHook("willUpdateProps", scope.decorate(swapped, "onWillUpdateProps"));
}

export function onMounted(fn: (scope: ComponentNode) => void | any) {
  const scope = getComponentScope();
  scope.addHook("mounted", scope.decorate(fn, "onMounted"));
}

export function onWillPatch(fn: (scope: ComponentNode) => any | void) {
  const scope = getComponentScope();
  scope.addHook("willPatch", scope.decorate(fn, "onWillPatch"), true);
}

export function onPatched(fn: (scope: ComponentNode) => void | any) {
  const scope = getComponentScope();
  scope.addHook("patched", scope.decorate(fn, "onPatched"));
}

export function onWillUnmount(fn: (scope: ComponentNode) => void | any) {
  const scope = getComponentScope();
  scope.addHook("willUnmount", scope.decorate(fn, "onWillUnmount"), true);
}

type OnErrorCallback = (error: any) => void | any;
export function onError(callback: OnErrorCallback) {
  const scope = getComponentScope();
  let handlers = nodeErrorHandlers.get(scope);
  if (!handlers) {
    handlers = [];
    nodeErrorHandlers.set(scope, handlers);
  }
  handlers.push(callback.bind(scope.component));
}
