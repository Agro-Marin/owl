export interface Run {
  outcomes: Map<string, string>;
  pythonFailures: Set<string>;
  result: string | null;
}
export interface Comparison {
  regressions: string[];
  fixed: string[];
  onlyBefore: string[];
  onlyAfter: string[];
  pythonRegressions: string[];
  pythonFixed: string[];
}
export declare function groupByAddon(tags: string[]): Map<string, string[]>;
export declare function parseRun(log: string): Run;
export declare function compareRuns(before: Run, after: Run): Comparison;
export declare function firstBad<T>(
  candidates: T[],
  isBad: (candidate: T) => boolean | Promise<boolean>
): Promise<T>;
export declare function findEnvironment(workspace: string): { conf: string; python: string } | null;
export declare function hootTestTag(suiteTag: string, testName: string): string;
