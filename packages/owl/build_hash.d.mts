export declare const SOURCES: string[];
export declare function buildHash(root: string): string;
export declare function sameSources(root: string, built: string, current?: string): boolean;
export declare function buildDate(
  root: string,
  hash?: string,
  env?: Record<string, string | undefined>
): string;
