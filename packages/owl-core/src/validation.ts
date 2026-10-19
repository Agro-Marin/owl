import { OwlError } from "./owl_error";

export interface ValidationIssue {
  message: string;
  path?: string;
  received?: any;
  [K: string]: any;
}

export interface ValidationContext {
  addIssue(issue: ValidationIssue): void;
  issueDepth: number;
  mergeIssues(issues: ValidationIssue[], depth?: number): void;
  path: PropertyKey[];
  validate(type: any): void;
  value: any;
  withIssues(issues: ValidationIssue[]): ValidationContext;
  withKey(key: PropertyKey): ValidationContext;
}

const PRINT_BUDGET = 1000;

function makeSafeReplacer() {
  const ancestors: object[] = [];
  const seen = new Set<object>();
  let printed = 0;
  return function (this: object, _key: string, value: any): any {
    if (typeof value === "function") {
      return value.name || "[Function]";
    }
    if (typeof value === "bigint") {
      return `${value}n`;
    }
    if (value && typeof value === "object") {
      const ctor = value.constructor;
      if (ctor && ctor !== Object && ctor !== Array) {
        return `[Instance of ${ctor.name || "anonymous"}]`;
      }
      while (ancestors.length && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      if (ancestors.includes(value)) {
        return "[Circular]";
      }
      if (seen.has(value) && printed >= PRINT_BUDGET) {
        return "[Repeated]";
      }
      seen.add(value);
      printed += 1 + (Array.isArray(value) ? value.length : Object.keys(value).length);
      ancestors.push(value);
    }
    return value;
  };
}

export function assertType(
  value: any,
  validation: any,
  errorMessage = "Value does not match the type"
): void {
  const issues = validateType(value, validation);
  if (issues.length) {
    const issueStrings = JSON.stringify(issues, makeSafeReplacer(), 2);
    throw new OwlError(`${errorMessage}\n${issueStrings}`);
  }
}

const checkedTypes = new WeakMap<Function, string | null>();

function typeError(type: unknown): string | null {
  if (typeof type !== "function") {
    return `${type === null ? "null" : typeof type} is not a type`;
  }
  let error = checkedTypes.get(type);
  if (error === undefined) {
    const source = Function.prototype.toString.call(type);
    const isConstructor =
      source.startsWith("class") ||
      (Object.hasOwn(type, "prototype") && /\{\s*\[native code\]\s*\}$/.test(source));
    error = isConstructor
      ? `${type.name || "an anonymous class"} is a constructor, not a type (use t.string(), t.instanceOf(...), ...)`
      : null;
    checkedTypes.set(type, error);
  }
  return error;
}

function createContext(
  issues: ValidationIssue[],
  value: any,
  path: PropertyKey[],
  parent?: ValidationContext
): ValidationContext {
  return {
    issueDepth: 0,
    path,
    value,
    addIssue(issue) {
      issues.push({
        received: this.value,
        path: this.path.join(" > "),
        ...issue,
      });
    },
    mergeIssues(newIssues, depth = 0) {
      issues.push(...newIssues);
      this.issueDepth = Math.max(this.issueDepth, depth);
    },
    validate(type: any) {
      const error = typeError(type);
      if (error) {
        const at = this.path.length ? ` at "${this.path.join(" > ")}"` : "";
        throw new OwlError(`Invalid schema${at}: ${error}`);
      }
      const before = issues.length;
      type(this);
      if (issues.length > before && parent) {
        parent.issueDepth = Math.max(parent.issueDepth, this.issueDepth + 1);
      }
    },
    withIssues(issues) {
      return createContext(issues, this.value, this.path);
    },
    withKey(key) {
      return createContext(issues, this.value[key], this.path.concat(key), this);
    },
  };
}

export function validateType(value: any, validation: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  createContext(issues, value, []).validate(validation);
  return issues;
}
