import { STATUS } from "./status";
import { EventModifier, OwlError, setCurrentEvent } from "@odoo/owl-core";

export const mainEventHandler = (data: any, ev: Event, currentTarget?: EventTarget | null) => {
  // lets `useListener` skip an event older than the listener
  setCurrentEvent(ev);
  // data is [handler, context, modifiers?]: see EventModifier
  const modifiers: number = data[2];
  let stopped = false;
  if (modifiers) {
    if (modifiers & EventModifier.PREVENT_ANY) {
      ev.preventDefault();
    }
    if (modifiers & EventModifier.STOP_ANY) {
      ev.stopPropagation();
      stopped = true;
    }
    if (modifiers & EventModifier.SELF && ev.target !== currentTarget) {
      return stopped;
    }
    if (modifiers & EventModifier.PREVENT) {
      ev.preventDefault();
    }
    if (modifiers & EventModifier.STOP) {
      ev.stopPropagation();
      stopped = true;
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
    if (node ? node.status === STATUS.MOUNTED : true) {
      handler(context, ev);
    }
  }
  return stopped;
};
