import { STATUS } from "./status";
import { debug, debugLog, EventModifier, setCurrentEvent } from "@odoo/owl-core";
import type { HandlerFn } from "./blockdom/config";

// handler and modifiers are static (see EventModifier); context and model are
// what the latest render gave: model, the extra argument, only a t-model
// handler has
export const mainEventHandler = (
  handler: HandlerFn | null,
  modifiers: number,
  context: any,
  ev: Event,
  currentTarget: EventTarget | null,
  model?: any
) => {
  // lets `useListener` skip an event older than the listener
  setCurrentEvent(ev);
  if (modifiers) {
    if (modifiers & EventModifier.PREVENT_ANY) {
      ev.preventDefault();
    }
    if (modifiers & EventModifier.STOP_ANY) {
      ev.stopPropagation();
    }
    if (modifiers & EventModifier.SELF && ev.target !== currentTarget) {
      if (debug.event) {
        debugLog("event", `${ev.type}: skipped by .self, not from its own element`);
      }
      return;
    }
    if (modifiers & EventModifier.PREVENT) {
      ev.preventDefault();
    }
    if (modifiers & EventModifier.STOP) {
      ev.stopPropagation();
    }
  }
  // an empty handler (`t-on-click.stop=""`) is null
  if (handler !== null) {
    let node = context ? context.__owl__ : null;
    const live = node ? node.status === STATUS.MOUNTED : true;
    if (debug.event) {
      debugLog(
        "event",
        `${ev.type} on ${(currentTarget as Element | null)?.nodeName ?? "?"}: ${live ? "handled" : "dropped, component not mounted"} by ${node ? node.componentName : "a handler"}`,
        ev
      );
    }
    if (live) {
      // only a t-model handler carries its model (never undefined: modelExpr
      // checks it): any other handler gets exactly (context, event)
      if (model !== undefined) {
        handler(context, ev, model);
      } else {
        handler(context, ev);
      }
    }
  }
};
