import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    rounds: { type: "string", default: "11" },
    iterations: { type: "string", default: "100000" },
    filter: { type: "string" },
  },
});
const rounds = Number(values.rounds);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(rounds) && rounds >= 3, "rounds must be an integer >= 3");
assert(Number.isSafeInteger(iterations) && iterations >= 10, "iterations must be an integer >= 10");
const roots = values.baseline
  ? [resolve(values.baseline), resolve(values.candidate)]
  : [resolve(values.candidate)];
const labels = values.baseline ? ["baseline", "candidate"] : ["candidate"];
const directory = scratchDir("owl-reactivity-bench");
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const drain = () => new Promise((resolve) => setImmediate(resolve));

async function bundle(entry, name) {
  const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const path = join(directory, `${name}.mjs`);
  await writeFile(path, outputFiles[0].contents);
  return import(pathToFileURL(path));
}

async function sourceHashes(path) {
  const files = execFileSync("git", ["-C", root, "ls-files", "packages/owl-core/src"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  return Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(join(path, name)))
          .digest("hex"),
      ])
    )
  );
}

try {
  const source = await Promise.all(
    roots.map(async (path) => ({ path, sha256: await sourceHashes(path) }))
  );
  const modules = await Promise.all(
    roots.map((path, i) => bundle(join(path, "packages/owl-core/src/index.ts"), labels[i]))
  );
  const { workloads } = await bundle(
    join(root, "packages/owl-core/bench/workloads.ts"),
    "workloads"
  );
  const selected = Object.entries(workloads).filter(
    ([name]) => !values.filter || new RegExp(values.filter).test(name)
  );
  assert(selected.length, "filter selected no workloads");
  const validation = {};
  for (let m = 0; m < modules.length; m++) {
    const owl = modules[m];
    validation[labels[m]] = {};
    for (const [name, factory] of selected) {
      let events = 0;
      const tail = [];
      owl.setDebugSink((channel, message) => {
        events++;
        tail.push(`${channel}: ${message}`);
        if (tail.length > 12) tail.shift();
      });
      owl.setDebug("reactivity,effect,computed,scope,error");
      const workload = factory(owl);
      try {
        workload.run(10);
        const state = workload.validate();
        validation[labels[m]][name] = { state, events, tail: [...tail] };
        console.debug(
          "[owl:bench-validation]",
          labels[m],
          name,
          JSON.stringify(validation[labels[m]][name])
        );
      } finally {
        workload.dispose();
        await drain();
        owl.setDebug(false);
        owl.setDebugSink(null);
      }
    }
  }
  const samples = {};
  for (const [name, factory] of selected) {
    const fixtures = modules.map(factory);
    const timings = modules.map(() => []);
    try {
      fixtures.forEach((fixture) => fixture.run(Math.min(iterations, 10000)));
      await drain();
      for (let round = 0; round < rounds; round++) {
        const order = modules.map((_, i) => i);
        if (round % 2) order.reverse();
        for (const m of order) {
          const start = performance.now();
          fixtures[m].run(iterations);
          timings[m].push(((performance.now() - start) * 1e6) / iterations);
          await drain();
        }
      }
      const medians = Object.fromEntries(labels.map((label, i) => [label, median(timings[i])]));
      samples[name] = {
        ns_per_iteration: medians,
        samples_ns: Object.fromEntries(labels.map((label, i) => [label, timings[i]])),
        ...(modules.length === 2 ? { ratio: medians.candidate / medians.baseline } : {}),
      };
      console.debug(
        "[owl:bench-timing]",
        name,
        JSON.stringify({ ...medians, ratio: samples[name].ratio })
      );
      samples[name].validated_after_timing = {};
      for (let m = 0; m < modules.length; m++) {
        const owl = modules[m];
        owl.setDebugSink((channel, message) =>
          console.debug(`[owl:bench-post:${labels[m]}] ${channel}: ${message}`)
        );
        owl.setDebug("reactivity,error");
        try {
          samples[name].validated_after_timing[labels[m]] = fixtures[m].validate();
        } finally {
          owl.setDebug(false);
          owl.setDebugSink(null);
        }
      }
    } finally {
      fixtures.forEach((fixture) => fixture.dispose());
      await drain();
    }
  }
  for (const entry of source)
    assert.deepEqual(
      await sourceHashes(entry.path),
      entry.sha256,
      "sources changed during measurement"
    );
  const result = {
    node: process.version,
    roots,
    labels,
    rounds,
    iterations,
    source,
    logging: "Debug logging validates each path; disabled only during warmup and timing.",
    unit: "nanoseconds per iteration; an iterator iteration consumes 32 values, insert/delete performs two mutations",
    validation,
    samples,
  };
  if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + "\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
