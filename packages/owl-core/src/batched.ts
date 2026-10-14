type Callback = (...args: any[]) => void;

export function batched(callback: Callback): Callback {
  let latestArgs: any[] | null = null;
  return function batchedCall(...args) {
    const scheduled = latestArgs !== null;
    latestArgs = args;
    if (!scheduled) {
      Promise.resolve().then(() => {
        const args = latestArgs!;
        latestArgs = null;
        callback(...args);
      });
    }
  };
}
