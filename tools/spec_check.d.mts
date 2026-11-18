export declare const SPECIFICATION: string;
export interface Rule {
  line: number;
  text: string;
  tests: { file: string; title: string }[];
}
export declare function parseRules(markdown: string): Rule[];
export declare function testTitles(source: string): Set<string>;
export declare function specificationErrors(
  markdown: string,
  root?: string
): { rules: number; references: number; errors: string[] };
