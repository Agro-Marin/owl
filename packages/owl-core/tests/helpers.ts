import { onTestFinished, vi, type Mock } from "vitest";
import { effect, Scope } from "../src";

export { expectSpy, nextMicroTick, waitScheduler } from "../../../tools/testing/helpers";

export class TestScope extends Scope {}

export function captureUnhandledRejections(): () => Promise<string[]> {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => reasons.push(reason);
  process.on("unhandledRejection", listener);
  onTestFinished(() => {
    process.off("unhandledRejection", listener);
  });
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return reasons.map((reason) => `${(reason as Error).name}: ${(reason as Error).message}`);
  };
}

export type SpyEffect = (() => () => void) & { spy: Mock };
export function spyEffect<T>(fn: () => T): SpyEffect {
  const spy = vi.fn(fn);
  const unsubscribeWrapper = () => effect(spy);
  const wrapped = Object.assign(unsubscribeWrapper, { spy }) as SpyEffect;
  return wrapped;
}
