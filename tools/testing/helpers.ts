import type { Mock } from "vitest";

export function nextMicroTick(): Promise<void> {
  return Promise.resolve();
}

export async function waitScheduler(): Promise<void> {
  await nextMicroTick();
  await nextMicroTick();
}

export async function waitSchedulerThenMicroTick(): Promise<void> {
  await nextMicroTick();
  return Promise.resolve();
}

export function expectSpy(
  spy: Mock,
  count: number,
  opt: { args?: any[]; result?: any } = {}
): void {
  expect(spy).toHaveBeenCalledTimes(count);
  if ("args" in opt) expect(spy).toHaveBeenLastCalledWith(...opt.args!);
  if ("result" in opt) expect(spy).toHaveReturnedWith(opt.result);
}

export function prng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

let lastFixture: HTMLDivElement | null = null;

export function makeTestFixture(): HTMLDivElement {
  const fixture = document.createElement("div");
  document.body.appendChild(fixture);
  if (lastFixture) {
    lastFixture.remove();
  }
  lastFixture = fixture;
  return fixture;
}
