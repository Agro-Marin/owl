import { countModifiers } from "./blockdom/config";
import { STATUS } from "./status";
import { OwlError, setCurrentEvent } from "@odoo/owl-core";

export const mainEventHandler = (data: any, ev: Event, currentTarget?: EventTarget | null) => {
  // lets `useListener` skip an event older than the listener
  setCurrentEvent(ev);
  const handlerIndex = countModifiers(data);
  let stopped = false;
  if (handlerIndex) {
    let selfMode = false;
    const isSelf = ev.target === currentTarget;
    for (let i = 0; i < handlerIndex; i++) {
      switch (data[i]) {
        case "self":
          selfMode = true;
          if (isSelf) {
            continue;
          } else {
            return stopped;
          }
        case "prevent":
          if ((selfMode && isSelf) || !selfMode) ev.preventDefault();
          continue;
        case "stop":
          if ((selfMode && isSelf) || !selfMode) ev.stopPropagation();
          stopped = true;
          continue;
      }
    }
  }
  // If handler is empty, its slot is a hole: data does not have the property.
  // We check this rather than the slot being truthy (or typeof function) so
  // that it crashes as expected when a handler expression evaluates to a falsy
  // value
  if (Object.hasOwnProperty.call(data, handlerIndex)) {
    const handler = data[handlerIndex];
    if (typeof handler !== "function") {
      throw new OwlError(`Invalid handler (expected a function, received: '${handler}')`);
    }
    const context = data[handlerIndex + 1];
    let node = context ? context.__owl__ : null;
    if (node ? node.status === STATUS.MOUNTED : true) {
      handler(context, ev);
    }
  }
  return stopped;
};
