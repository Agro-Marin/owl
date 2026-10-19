export declare const ROOT: string;
export declare const PACKAGE_SOURCES: Record<
  "@odoo/owl-core" | "@odoo/owl-compiler" | "@odoo/owl-runtime",
  string
>;
export declare const REQUIRED_NODE: number;
export declare function checkNodeVersion(): void;
export declare const ODOO_CANDIDATES: string[];
export declare function defaultOdoo(): string | undefined;
export declare function scratchDir(prefix: string): string;
export declare const TEST_DEFAULTS: {
  root: string;
  globals: boolean;
  testTimeout: number;
  globalSetup: string[];
  expect: { requireAssertions: boolean };
};
