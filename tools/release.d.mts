export declare const PACKAGES: string[];
export declare const VERSION_FILE: string;
export declare const CHANGELOG: string;
export declare const FORK_BASE: string;
export declare function compareVersions(a: string, b: string): number;
export declare function changelogSection(version: string, date: string, subjects: string[]): string;
export declare function release(options: {
  root?: string;
  version: string;
  date: string;
  base?: string;
  log?: (line: string) => void;
}): void;
