// Handler data is `[...modifiers, handler, context]`: the number of leading
// modifier strings is the index of the handler slot.
export function countModifiers(data: any[]): number {
  let count = 0;
  let item;
  while ((item = data[count]) && typeof item === "string") {
    count++;
  }
  return count;
}

export const config = {
  // whether or not blockdom should normalize DOM whenever a block is created.
  // Normalizing dom mean removing empty text nodes (or containing only spaces)
  shouldNormalizeDom: true,

  // this is the main event handler. Every event handler registered with blockdom
  // will go through this function, giving it the data registered in the block
  // and the event
  mainEventHandler: (data: any, ev: Event, currentTarget?: EventTarget | null): boolean => {
    if (typeof data === "function") {
      data(ev);
    } else if (Array.isArray(data)) {
      const index = countModifiers(data);
      data[index](data[index + 1], ev);
    }
    return false;
  },
};
