export interface Equivalent {
  tool: string;
  file: string;
  line: number;
  operator: string;
  original: string;
  replacement: string;
  reason: string;
  matched?: boolean;
  currentLine?: number;
}
export declare const EQUIVALENTS_FILE: string;
export declare const LINE_TOLERANCE: number;
export declare function normalize(text: string): string;
export declare function mutantKey(mutant: Omit<Equivalent, "reason">): string;
export declare function loadEquivalents(path?: string): Map<string, Equivalent[]>;
export declare function isEquivalent(
  equivalents: Map<string, Equivalent[]>,
  mutant: Omit<Equivalent, "reason">
): boolean;
export declare function staleEquivalents(
  equivalents: Map<string, Equivalent[]>,
  files: string[],
  tools: string[]
): Equivalent[];
export declare function writeEquivalentLines(path?: string): number;
