export declare const FILES: string[];
export declare function updateVersions(
  text: string,
  owl: { version: string; commit: string; checksums: Record<string, string> }
): string;
export declare function vendor(options: {
  odoo: string;
  check: boolean;
  root?: string;
  log?: (line: string) => void;
}): number;
