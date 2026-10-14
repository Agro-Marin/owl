import { mainEventHandler } from "../event_handling";

export type HandlerFn = (ctx: any, ev: Event, arg?: any) => any;

export const config = {
  mainEventHandler: mainEventHandler as (
    fn: HandlerFn | null,
    mods: number,
    ctx: any,
    ev: Event,
    currentTarget: EventTarget | null,
    arg?: any
  ) => void,
};
