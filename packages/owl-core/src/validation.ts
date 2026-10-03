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
  mergeIssues(issues: ValidationIssue[]): void;
  path: PropertyKey[];
  validate(type: any): void;
  value: any;
  withIssues(issues: ValidationIssue[]): ValidationContext;
  withKey(key: PropertyKey): ValidationContext;
}

// Objects a message prints in full: past it, an object met before is a marker,
// so values sharing sub-objects (a DAG) stay linear instead of exponential.
const PRINT_BUDGET = 1000;

// A JSON.stringify replacer that prints a value seen twice in full, and only
// a value that contains itself as "[Circular]": `ancestors` is the path from
// the root to the object being serialized (the replacer's `this`).
function makeSafeReplacer() {
  const ancestors: object[] = [];
  const seen = new Set<object>();
  let printed = 0;
  return function (this: object, _key: string, value: any): any {
    if (typeof value === "function") {
      return value.name || "[Function]";
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
      printed++;
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

function createContext(
  issues: ValidationIssue[],
  value: any,
  path: PropertyKey[],
  parent?: ValidationContext,
  // depth of this context's value relative to its parent: a `withKey` child is
  // one level below, a `withIssues` probe (union member) stays at the same
  // level. Union probe failures must not look like deep failures to an
  // enclosing union, or it would stop trying the remaining members.
  depthOffset = 1
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
    mergeIssues(newIssues) {
      issues.push(...newIssues);
    },
    validate(type: any) {
      // `issues` may already hold a sibling's issues: only this call's count
      const before = issues.length;
      type(this);
      if (issues.length > before && parent) {
        parent.issueDepth = Math.max(parent.issueDepth, this.issueDepth + depthOffset);
      }
    },
    withIssues(issues) {
      return createContext(issues, this.value, this.path, this, 0);
    },
    withKey(key) {
      return createContext(issues, this.value[key], this.path.concat(key), this);
    },
  };
}

export function validateType(value: any, validation: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validation(createContext(issues, value, []));
  return issues;
}
