import { afterAll, afterEach, beforeEach } from "vitest";
import { inspect } from "node:util";
import { setDebug, setDebugSink, type DebugChannel } from "../../packages/owl-core/src/debug";
import { consoleOutput } from "./console";

for (const method of ["warn", "info", "log", "error"] as const) {
  console[method] = (...args: unknown[]) => {
    consoleOutput.push(`${method}:${args[0]}`);
  };
}

const traces: Array<{ channel: DebugChannel; message: string; details: unknown[] }> = [];
const TRACE_LIMIT = 100;
let totalTraces = 0;

beforeEach(() => {
  traces.length = 0;
  setDebugSink((channel, message, details) => {
    totalTraces++;
    if (traces.length === TRACE_LIMIT) traces.shift();
    traces.push({ channel, message, details });
  });
  setDebug(process.env.OWL_DEBUG || false);
});

afterEach((context) => {
  const remaining = consoleOutput.splice(0);
  try {
    if ((remaining.length || context.task.result?.state === "fail") && traces.length) {
      console.debug(
        `[owl:test-debug] ${context.task.name}, last ${traces.length} trace(s)`,
        traces.map(
          ({ channel, message, details }) =>
            `[owl:${channel}] ${message}${details.length ? " " + inspect(details, { depth: 1, maxArrayLength: 10, maxStringLength: 200 }) : ""}`
        )
      );
    }
    if (remaining.length) {
      throw new Error(`Unexpected console output:\n${remaining.join("\n")}`);
    }
  } finally {
    traces.length = 0;
    setDebug(false);
    setDebugSink(null);
  }
});

afterAll(() => {
  if (process.env.OWL_DEBUG) {
    console.debug(`[owl:test-debug] collected ${totalTraces} trace(s)`);
  }
});
