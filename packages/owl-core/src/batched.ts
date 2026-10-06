type Callback = (...args: any[]) => void;

/**
 * Creates a batched version of a callback so that all calls to it in the same
 * microtick will only call the original callback once, with the arguments of
 * the latest call.
 *
 * @param callback the callback to batch
 * @returns a batched version of the original callback
 */
export function batched(callback: Callback): Callback {
  let latestArgs: any[] | null = null;
  return function batchedCall(...args) {
    const scheduled = latestArgs !== null;
    latestArgs = args;
    if (!scheduled) {
      // Intentionally Promise-based: errors thrown by `callback` surface as
      // unhandled promise rejections, which vitest's `onUnhandledError` hook
      // intercepts (see tests/effect.test.ts using `IntentionalTestError`).
      // Switching to `queueMicrotask` routes errors through a different
      // uncaught-exception channel and complicates the debugging workflow.
      Promise.resolve().then(() => {
        const args = latestArgs!;
        latestArgs = null;
        callback(...args);
      });
    }
  };
}
