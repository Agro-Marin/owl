export const config = {
  // this is the main event handler. Every event handler registered with blockdom
  // will go through this function, giving it the data registered in the block
  // and the event
  mainEventHandler: (data: any, ev: Event, currentTarget?: EventTarget | null): void => {
    if (typeof data === "function") {
      data(ev);
    } else if (Array.isArray(data)) {
      data[0](data[1], ev);
    }
  },
};
