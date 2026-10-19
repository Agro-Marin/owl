import { defineConfig } from "eslint/config";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";

const rules = {
  "no-restricted-globals": ["error", "event", "self"],
  "no-const-assign": ["error"],
  "no-debugger": ["error"],
  "no-dupe-class-members": ["error"],
  "no-dupe-keys": ["error"],
  "no-dupe-args": ["error"],
  "no-dupe-else-if": ["error"],
  "no-unsafe-negation": ["error"],
  "no-duplicate-imports": ["error"],
  "valid-typeof": ["error"],
  "no-restricted-syntax": [
    "error",
    {
      selector: "MemberExpression[object.name='test'][property.name='only']",
      message: "test.only(...) is forbidden",
    },
    {
      selector: "MemberExpression[object.name='describe'][property.name='only']",
      message: "describe.only(...) is forbidden",
    },
  ],
};

const unusedVars = {
  vars: "all",
  args: "none",
  ignoreRestSiblings: false,
  caughtErrors: "all",
};

export default defineConfig([
  {
    ignores: ["**/dist/**", "tools/owl-vision/**", "tools/playground/libs/**"],
  },
  {
    files: ["**/*.ts"],
    plugins: {
      "@typescript-eslint": typescriptEslint,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        describe: true,
        expect: true,
        test: true,
        beforeEach: true,
        beforeAll: true,
        afterEach: true,
        afterAll: true,
        jest: true,
      },
      parser: tsParser,
      sourceType: "module",
      parserOptions: {
        project: ["packages/*/tsconfig.tests.json", "tools/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...rules,
      "@typescript-eslint/no-unused-vars": ["error", unusedVars],
      "@typescript-eslint/await-thenable": ["error"],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      ...rules,
      "no-unused-vars": ["error", unusedVars],
      "no-undef": ["error"],
    },
  },
  {
    files: ["tools/benchmarks/**/*.mjs", "tools/odoo_migration/*.mjs"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
]);
