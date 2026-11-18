import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareRuns,
  findEnvironment,
  firstBad,
  groupByAddon,
  hootTestTag,
  parseRun,
} from "./odoo_gate_lib.mjs";
import { scratchDir } from "./workspace.mjs";

const prefix = "2026-11-18 10:00:00,000 1 INFO uid:- db rid:- odoo.addons.web.tests.test_js";
const hoot = (runner: string, name: string, status: string) =>
  `${prefix}.${runner}.browser: [HOOT] Test "${name}" ${status} (assertions: 1 / time: 1 ms)`;

test("test tags are grouped by addon, one database each", () => {
  expect([...groupByAddon(["/web:WebSuite", "/mail:MailSuite", "/web:MobileWebSuite"])]).toEqual([
    ["web", ["/web:WebSuite", "/web:MobileWebSuite"]],
    ["mail", ["/mail:MailSuite"]],
  ]);
  expect(() => groupByAddon(["WebSuite"])).toThrow("does not name an addon");
});

test("a run's log gives each HOOT test's outcome per runner, its Python failures and its result", () => {
  const run = parseRun(
    [
      hoot("WebSuite.test_form", "@web/a", "passed"),
      hoot("MobileWebSuite.test_form", "@web/a", "failed:"),
      hoot("WebSuite.test_form", "@web/b", "timed out"),
      hoot("WebSuite.test_form", "@web/b", "passed"),
      `${prefix}: [HOOT] something else`,
      "2026-11-18 10:00:01,000 1 ERROR uid:- db rid:- odoo.addons.web.tests.test_js: FAIL: MobileWebSuite.test_form",
      "  odoo.addons.web.tests.test_js.WebSuite.test_form.browser: Some tests failed: see above",
      "2026-11-18 10:00:02,000 1 ERROR uid:- db rid:- odoo.tests.result: 1 failed, 0 error(s) of 2 tests",
    ].join("\n")
  );
  expect([...run.outcomes]).toEqual([
    ["WebSuite.test_form › @web/a", "passed"],
    ["MobileWebSuite.test_form › @web/a", "failed"],
    ["WebSuite.test_form › @web/b", "failed"],
  ]);
  expect([...run.pythonFailures]).toEqual(["MobileWebSuite.test_form"]);
  expect(run.result).toBe("1 failed, 0 error(s) of 2 tests");
});

test("two runs compare test by test: regressions, fixes, and tests only one side ran", () => {
  const before = parseRun(
    [
      hoot("WebSuite.test_form", "@web/kept", "passed"),
      hoot("WebSuite.test_form", "@web/broken", "passed"),
      hoot("WebSuite.test_form", "@web/repaired", "failed:"),
      hoot("WebSuite.test_form", "@web/gone", "passed"),
      "x ERROR y: FAIL: WebSuite.test_misc",
    ].join("\n")
  );
  const after = parseRun(
    [
      hoot("WebSuite.test_form", "@web/kept", "passed"),
      hoot("WebSuite.test_form", "@web/broken", "failed:"),
      hoot("WebSuite.test_form", "@web/repaired", "passed"),
      hoot("WebSuite.test_form", "@web/new", "passed"),
      "x ERROR y: FAIL: WebSuite.test_core",
    ].join("\n")
  );
  expect(compareRuns(before, after)).toEqual({
    regressions: ["WebSuite.test_form › @web/broken"],
    fixed: ["WebSuite.test_form › @web/repaired"],
    onlyBefore: ["WebSuite.test_form › @web/gone (passed)"],
    onlyAfter: ["WebSuite.test_form › @web/new (passed)"],
    pythonRegressions: ["WebSuite.test_core"],
    pythonFixed: ["WebSuite.test_misc"],
  });
});

test("bisection finds the first bad candidate in a logarithmic number of probes", async () => {
  const candidates = Array.from({ length: 18 }, (_, i) => i);
  for (const culprit of [0, 5, 17]) {
    const probed: number[] = [];
    const found = await firstBad(candidates, async (candidate) => {
      probed.push(candidate);
      return candidate >= culprit;
    });
    expect(found).toBe(culprit);
    expect(probed.length).toBeLessThanOrEqual(5);
    expect(probed).not.toContain(17);
  }
});

test("the environment is the first <env>.conf with an <env>/bin/python beside it", () => {
  const workspace = scratchDir("owl-gate-env");
  try {
    writeFileSync(join(workspace, "a.conf"), "");
    writeFileSync(join(workspace, "b.conf"), "");
    mkdirSync(join(workspace, "b/bin"), { recursive: true });
    writeFileSync(join(workspace, "b/bin/python"), "");
    expect(findEnvironment(workspace)).toEqual({
      conf: join(workspace, "b.conf"),
      python: join(workspace, "b/bin/python"),
    });
    rmSync(join(workspace, "b"), { recursive: true });
    expect(findEnvironment(workspace)).toBe(null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a single HOOT test is selected by a test tag parameter, which cannot hold a comma", () => {
  expect(hootTestTag("/web:MobileWebSuite.test_form", "@web/views/form/x on mobile")).toBe(
    "/web:MobileWebSuite.test_form[@web/views/form/x on mobile]"
  );
  expect(() => hootTestTag("/web:WebSuite", "@web/a, b")).toThrow("holds a comma");
});
