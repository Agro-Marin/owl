export const DEBUG_CHANNELS = [
  "reactivity",
  "effect",
  "computed",
  "scope",
  "plugin",
  "scheduler",
  "fiber",
  "lifecycle",
  "error",
  "template",
  "event",
] as const;

export type DebugChannel = (typeof DEBUG_CHANNELS)[number];

export type DebugSink = (channel: DebugChannel, message: string, details: unknown[]) => void;

export const debug: Record<DebugChannel, boolean> = /* @__PURE__ */ makeDebugFlags();

function makeDebugFlags(): Record<DebugChannel, boolean> {
  return Object.seal(Object.fromEntries(DEBUG_CHANNELS.map((channel) => [channel, false]))) as any;
}

const consoleSink: DebugSink = (channel, message, details) => {
  console.debug(`[owl:${channel}] ${message}`, ...details);
};

let sink: DebugSink = consoleSink;

export function setDebug(channels: boolean | string | readonly string[]): void {
  const wanted =
    typeof channels === "boolean"
      ? channels
        ? DEBUG_CHANNELS
        : []
      : typeof channels === "string"
        ? channels
            .split(",")
            .map((channel) => channel.trim())
            .filter(Boolean)
        : channels;
  for (const channel of wanted) {
    if (!(DEBUG_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(
        `Unknown debug channel "${channel}" (channels: ${DEBUG_CHANNELS.join(", ")})`
      );
    }
  }
  for (const channel of DEBUG_CHANNELS) {
    debug[channel] = wanted.includes(channel);
  }
}

export function setDebugSink(newSink: DebugSink | null): void {
  sink = newSink || consoleSink;
}

export function debugNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function debugLog(channel: DebugChannel, message: string, ...details: unknown[]): void {
  sink(channel, message, details);
}
