import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { checkNodeVersion, scratchDir } from "./workspace.mjs";

checkNodeVersion();

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string", default: root },
    output: { type: "string" },
    chrome: { type: "string", default: "google-chrome" },
    rounds: { type: "string", default: "15" },
    repetitions: { type: "string", default: "3" },
  },
});
const rounds = Number(values.rounds),
  repetitions = Number(values.repetitions);
assert(Number.isSafeInteger(rounds) && rounds >= 3);
assert(Number.isSafeInteger(repetitions) && repetitions >= 1);
const roots = values.baseline
  ? [resolve(values.baseline), resolve(values.candidate)]
  : [resolve(values.candidate)];
const labels = values.baseline ? ["baseline", "candidate"] : ["candidate"];
const directory = scratchDir("owl-navigation-bench");
const files = new Map();
const artifacts = {};
let browser, server;
let exited;
let result;
let browserExit;
const pending = new Map();
const logs = [];
const errors = [];
let requestId = 0;
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 180000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}
try {
  for (let i = 0; i < roots.length; i++) {
    const path = roots[i];
    const { outputFiles, metafile } = await build({
      stdin: {
        contents: `export * from ${JSON.stringify(join(path, "packages/owl/src/index.ts"))}; export {observersOf, atomSymbol} from ${JSON.stringify(join(path, "packages/owl-core/src/index.ts"))};`,
        resolveDir: root,
      },
      bundle: true,
      write: false,
      format: "esm",
      target: "esnext",
      metafile: true,
      alias: Object.fromEntries(
        ["core", "compiler", "runtime"].map((name) => [
          `@odoo/owl-${name}`,
          join(path, `packages/owl-${name}/src/index.ts`),
        ])
      ),
      define: {
        __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
        __BUILD_HASH__: JSON.stringify(`benchmark-${labels[i]}`),
      },
      plugins: [
        {
          name: "bundled-compiler",
          setup(build) {
            build.onResolve({ filter: /^\.\/bundled_compiler$/ }, (args) =>
              args.importer.endsWith("/owl-runtime/src/template_set.ts")
                ? { path: join(path, "packages/owl/src/bundled_compiler.ts") }
                : undefined
            );
          },
        },
      ],
    });
    files.set(`/${labels[i]}.mjs`, Buffer.from(outputFiles[0].contents));
    const hashes = Object.fromEntries(
      await Promise.all(
        Object.keys(metafile.inputs)
          .filter((input) => input !== "<stdin>")
          .map(async (input) => [
            resolve(input),
            createHash("sha256")
              .update(await readFile(resolve(input)))
              .digest("hex"),
          ])
      )
    );
    artifacts[labels[i]] = {
      root: path,
      bundle_sha256: createHash("sha256").update(outputFiles[0].contents).digest("hex"),
      source_sha256: hashes,
    };
  }
  files.set("/navigation.mjs", await readFile(join(root, "tools/benchmarks/navigation.mjs")));
  files.set(
    "/",
    Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Owl navigation benchmark</title></head><body><script type="module">
    ${labels.map((label) => `import * as ${label} from '/${label}.mjs';`).join("\n")}
    import {benchmarkNavigation} from '/navigation.mjs';
    window.benchmark = benchmarkNavigation([${labels.join(",")}],${rounds},${repetitions});
  </script></body></html>`)
  );
  server = createServer((request, response) => {
    const body = files.get(request.url);
    response.writeHead(body ? 200 : 404, {
      "Content-Type": request.url === "/" ? "text/html" : "text/javascript",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = spawn(
    values.chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--remote-debugging-pipe",
      `--user-data-dir=${directory}`,
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: true }
  );
  exited = new Promise((resolve) =>
    browser.once("close", (code, signal) => resolve({ code, signal }))
  );
  browser.on("error", (error) => {
    for (const deferred of pending.values()) {
      clearTimeout(deferred.timer);
      deferred.reject(error);
    }
    pending.clear();
  });
  browser.stderr.on("data", () => {});
  let buffer = "";
  browser.stdio[4].setEncoding("utf8");
  browser.stdio[4].on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\0")) !== -1) {
      const event = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (event.id) {
        const deferred = pending.get(event.id);
        if (!deferred) continue;
        pending.delete(event.id);
        clearTimeout(deferred.timer);
        if (event.error) deferred.reject(new Error(JSON.stringify(event.error)));
        else deferred.resolve(event.result);
      } else if (event.method === "Runtime.consoleAPICalled") {
        const line = event.params.args.map((arg) => arg.value ?? arg.description).join(" ");
        logs.push(line);
        console.debug(line);
      } else if (event.method === "Runtime.exceptionThrown")
        errors.push(event.params.exceptionDetails);
    }
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` }, sessionId);
  const response = await send(
    "Runtime.evaluate",
    {
      expression:
        "new Promise((resolve,reject)=>{const t=setInterval(()=>{if(window.benchmark){clearInterval(t);window.benchmark.then(resolve,reject);}},10);})",
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId
  );
  assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  for (const artifact of Object.values(artifacts)) {
    for (const [input, hash] of Object.entries(artifact.source_sha256))
      assert.equal(
        createHash("sha256")
          .update(await readFile(input))
          .digest("hex"),
        hash,
        `source changed: ${input}`
      );
  }
  result = { ...response.result.value, artifacts, logs };
} finally {
  if (browser) {
    const kill = (signal) => {
      if (!browser.pid) return;
      try {
        process.kill(-browser.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(() => kill("SIGKILL"), 5000);
    try {
      kill("SIGTERM");
      browserExit = await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  for (const deferred of pending.values()) {
    clearTimeout(deferred.timer);
    deferred.reject(new Error("browser closed"));
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
result.cleanup = {
  profile_removed: true,
  server_closed: true,
  browser_pid: browser.pid,
  browser_exit: browserExit,
};
if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + "\n");
