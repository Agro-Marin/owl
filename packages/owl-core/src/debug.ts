// -----------------------------------------------------------------------------
// Debug logging
// -----------------------------------------------------------------------------
//
// Opt-in, per channel. A call site reads one boolean before it builds anything:
//
//   if (debug.fiber) debugLog("fiber", "render", node.componentName);
//
// so a disabled channel costs a property read. Enable from code or a console:
//
//   setDebug(true);                        // every channel
//   setDebug(["fiber", "scheduler"]);      // some
//   setDebug("fiber,error");               // same, as a string
//   setDebug(false);                       // none
//
// Lines go to console.debug as `[owl:<channel>] <message>`, followed by the
// details as live objects; setDebugSink replaces the destination (a test that
// asserts on them, a ring buffer).
// -----------------------------------------------------------------------------

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

export const debug: Record<DebugChannel, boolean> = Object.seal({
  reactivity: false,
  effect: false,
  computed: false,
  scope: false,
  plugin: false,
  scheduler: false,
  fiber: false,
  lifecycle: false,
  error: false,
  template: false,
  event: false,
});

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

// A timestamp for a duration in a log line, where performance may be missing.
export function debugNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function debugLog(channel: DebugChannel, message: string, ...details: unknown[]): void {
  sink(channel, message, details);
}
