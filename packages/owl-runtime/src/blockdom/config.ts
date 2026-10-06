// The code of a t-on handler: static, one per handler expression of a template.
// It gets the context of the render that wrote it, the event, and for a t-model
// handler the model.
export type HandlerFn = (ctx: any, ev: Event, arg?: any) => any;

export const config = {
  // this is the main event handler. Every event handler registered with blockdom
  // goes through this function, given the handler's code and modifiers (static,
  // given to the block when it is built), the context the latest render gave it,
  // the event, the element listening and, for a handler with one, the extra
  // argument the latest render gave it
  mainEventHandler: (
    fn: HandlerFn | null,
    mods: number,
    ctx: any,
    ev: Event,
    currentTarget: EventTarget | null,
    arg?: any
  ): void => {
    if (fn) {
      if (arg === undefined) {
        fn(ctx, ev);
      } else {
        fn(ctx, ev, arg);
      }
    }
  },
};
