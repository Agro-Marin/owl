import { parseReport, placeFindings } from "../src/template_types/findings";

test("a finding is placed from 0, in its absolute file, naming its template", () => {
  const report = parseReport(
    JSON.stringify({
      findings: [
        {
          file: "addons/web/static/src/tooltip.xml",
          line: 5,
          column: 30,
          endLine: 6,
          endColumn: 4,
          code: "TS2339",
          message: "Property 'x' does not exist on type 'Tooltip'.",
          template: "web.Tooltip",
          component: "Tooltip",
        },
        { file: "/abs/a.xml", line: 1, column: 1, code: "TS2345", message: "m" },
        { file: null, code: "TS2339", message: "nowhere" },
      ],
    })
  );
  const { byFile, unplaced } = placeFindings(report, "/repo");
  expect(unplaced).toBe(1);
  expect(byFile.get("/repo/addons/web/static/src/tooltip.xml")).toEqual([
    {
      startLine: 4,
      startColumn: 29,
      endLine: 5,
      endColumn: 3,
      code: "TS2339",
      message: "Property 'x' does not exist on type 'Tooltip'. (web.Tooltip, Tooltip)",
    },
  ]);
  expect(byFile.get("/abs/a.xml")).toEqual([
    { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, code: "TS2345", message: "m" },
  ]);
});

test("output without a findings array is refused", () => {
  expect(() => parseReport(`{"errors": []}`)).toThrow("no findings array");
  expect(() => parseReport("node: not found")).toThrow();
});
