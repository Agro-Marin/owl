export declare const OPERATORS: string[];
export interface Mutant {
  operator: string;
  line: number;
  start: number;
  end: number;
  anchors: number[];
  original: string;
  replacement: string;
  text: string;
}
export declare function generateMutants(
  source: string,
  fileName: string,
  operators?: string[]
): Mutant[];
