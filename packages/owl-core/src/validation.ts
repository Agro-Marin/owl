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

// Entries a message prints in full: past it, an object met before is a
// marker, so values sharing sub-objects (a DAG) stay linear instead of
// exponential.
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
      // the budget counts what an object prints, not just the object: one
      // large array met many times must not be printed many times
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

// A schema entry that is not a validator: a constructor (OWL 2's `{ a: String
// }` props syntax) would be called with the context and accept anything.
const checkedTypes = new WeakMap<Function, string | null>();

function typeError(type: unknown): string | null {
  if (typeof type !== "function") {
    return `${type === null ? "null" : typeof type} is not a type`;
  }
  let error = checkedTypes.get(type);
  if (error === undefined) {
    const source = Function.prototype.toString.call(type);
    // a bound function prints as native code too, but has no prototype
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

// A context for `value` at `path`. A `withKey` child reports to its parent
// how deep below it an issue was found; a `withIssues` probe (a union member,
// a customValidator's type) does not: its caller reads its depth, and merges
// its issues with that depth only when it keeps them.
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
        throw new OwlError(`Invalid schema at "${this.path.join(" > ")}": ${error}`);
      }
      // `issues` may already hold a sibling's issues: only this call's count
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
  validation(createContext(issues, value, []));
  return issues;
}
