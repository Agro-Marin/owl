import { STATUS } from "./status";
import { debug, debugLog, EventModifier, OwlError, setCurrentEvent } from "@odoo/owl-core";

export const mainEventHandler = (data: any, ev: Event, currentTarget?: EventTarget | null) => {
  // lets `useListener` skip an event older than the listener
  setCurrentEvent(ev);
  // data is [handler, context, modifiers?, extra?]: see EventModifier; extra
  // is the model of a t-model handler
  const modifiers: number = data[2];
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
  const handler = data[0];
  // an empty handler (`t-on-click.stop=""`) is null; a handler expression
  // evaluating to something else than a function is an error
  if (handler !== null) {
    if (typeof handler !== "function") {
      throw new OwlError(`Invalid handler (expected a function, received: '${handler}')`);
    }
    const context = data[1];
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
      handler(context, ev, data[3]);
    }
  }
};
