export declare const FILES: string[];
export declare const DEFAULT_PROBE: { file: string; pattern: string };
export interface OwlPin {
  version?: string;
  commit?: string;
  checksums?: Record<string, string>;
  probe?: { file: string; pattern: string };
}
export declare function updateVersions(
  text: string,
  owl: { version: string; commit: string; checksums: Record<string, string> }
): string;
export declare function bundleVersion(file: string, text: string): string;
export declare function releaseVersion(
  packageVersion: string,
  built: Record<string, Buffer>
): string;
export declare function pinErrors(pin: OwlPin, files: Record<string, Buffer | null>): string[];
export declare function uncommittedChanges(root: string): string[];
export declare function vendor(options: {
  odoo: string;
  check: boolean;
  root?: string;
  log?: (line: string) => void;
}): number;
