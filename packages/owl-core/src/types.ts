import { atomSymbol, type ReactiveValue } from "./computations";
import { OwlError } from "./owl_error";
import { ValidationContext, ValidationIssue } from "./validation";

export type Constructor<T = any> = { new (...args: any[]): T };

const defaultSymbol = Symbol("default");
const innerTypeSymbol = Symbol("innerType");
const shapeSymbol = Symbol("shape");
const elementTypeSymbol = Symbol("elementType");
const optionalSymbol = Symbol("optional");
const intersectionSymbol = Symbol("intersection");

export declare const hasDefault: unique symbol;
export type WithDefault<T> = T & { [hasDefault]: T };

export declare const isOptional: unique symbol;
export type Optional<T> = T & { [isOptional]: T };

export declare const typeBrand: unique symbol;
export type Type<T> = T & {
  [typeBrand]: T;
  optional(): Optional<T>;
  optional(value: T extends Function ? () => T : T | (() => T)): WithDefault<T>;

  type: T;
};

export type ShapeType<Shape, T> = Type<T> & {
  toShape(): Shape;
};

type MemberShape<M> = M extends { toShape(): infer S } ? S : never;
type MergedShape<T extends any[]> = UnionToIntersection<MemberShape<T[number]>>;
type IntersectionValue<T extends any[]> = [T[number]] extends [never]
  ? unknown
  : UnionToIntersection<
        T[number] extends infer M ? (M extends any ? { value: StripBrands<M> } : never) : never
      > extends { value: infer V }
    ? V
    : never;

type IsAny<T> = 0 extends 1 & T ? true : false;
type HasDefault<T> = IsAny<T> extends true ? false : T extends { [hasDefault]: any } ? true : false;
type IsOptional<T> = IsAny<T> extends true ? false : T extends { [isOptional]: any } ? true : false;
type StripDefault<T> = T extends { [hasDefault]: infer U } ? U : T;
type StripOptional<T> = T extends { [isOptional]: infer U } ? U | undefined : T;
type StripType<T> = T extends { [typeBrand]: infer U } ? U : T;
export type StripBrands<T> = StripType<StripDefault<StripOptional<T>>>;
type StripBrandsAll<T extends any[]> = { [K in keyof T]: StripBrands<T[K]> };

export type GetDefaultedKeys<T> = keyof T extends infer K
  ? K extends keyof T
    ? HasDefault<T[K]> extends true
      ? K
      : never
    : never
  : never;

export type GetOptionalEntries<T> = {
  [K in keyof T as IsOptional<T[K]> extends true
    ? K
    : HasDefault<T[K]> extends true
      ? K
      : never]?: StripBrands<T[K]>;
};
type GetRequiredEntries<T> = {
  [K in keyof T as IsOptional<T[K]> extends true
    ? never
    : HasDefault<T[K]> extends true
      ? never
      : K]: StripBrands<T[K]>;
};
export type PrettifyShape<T> = T extends Function ? T : { [K in keyof T]: T[K] };
export type ResolveOptionalEntries<T> = PrettifyShape<
  GetRequiredEntries<T> & GetOptionalEntries<T>
>;

export type ResolveReaderObjectType<T> = PrettifyShape<
  {
    [K in keyof T as IsOptional<T[K]> extends true ? never : K]: StripBrands<T[K]>;
  } & {
    [K in keyof T as IsOptional<T[K]> extends true ? K : never]?: StripBrands<T[K]>;
  }
>;

export type KeyedObject<K extends string[]> = {
  [P in K[number]]: any;
};

type ResolveShapedObject<T extends {}> = PrettifyShape<ResolveOptionalEntries<T>>;
export type ResolveObjectType<T extends {}> = ResolveShapedObject<
  T extends string[] ? KeyedObject<T> : T
>;

export type UnionToIntersection<U> = (U extends any ? (_: U) => any : never) extends (
  _: infer I
) => void
  ? I
  : never;

export function getDefault(type: any): (() => any) | undefined {
  return typeof type === "function" ? type[defaultSymbol] : undefined;
}

function makeOptional(type: any, value?: any): any {
  const validate = function validateOptional(context: ValidationContext) {
    if (context.value === undefined) {
      return;
    }
    context.validate(type);
  } as any;
  validate[optionalSymbol] = true;
  validate[innerTypeSymbol] = type;
  if (value !== undefined) {
    validate[defaultSymbol] = typeof value === "function" ? value : () => value;
  }
  validate.optional = (newValue?: any) =>
    makeOptional(type, newValue !== undefined ? newValue : validate[defaultSymbol]);
  return validate;
}

function isOptionalType(type: any): boolean {
  return typeof type === "function" && optionalSymbol in type;
}

function makeType(validate: (context: ValidationContext) => void): any {
  (validate as any).optional = (value?: any) => makeOptional(validate, value);
  return validate;
}

export function applyDefaults<T>(value: unknown, type: T): StripBrands<T> {
  return applyDefaultsRec(value, type);
}

function applyDefaultsRec(value: any, type: any): any {
  if (typeof type !== "function") {
    return value;
  }
  if (value === undefined) {
    const factory = type[defaultSymbol];
    if (!factory) {
      return value;
    }
    value = factory();
  }
  let inner = type;
  while (typeof inner === "function" && inner[innerTypeSymbol]) {
    inner = inner[innerTypeSymbol];
  }
  if (typeof inner !== "function" || !value || typeof value !== "object") {
    return value;
  }
  const members = inner[intersectionSymbol];
  if (members) {
    let result = value;
    for (const member of members) {
      result = applyDefaultsRec(result, member);
    }
    return result;
  }
  const elementType = inner[elementTypeSymbol];
  if (elementType && Array.isArray(value)) {
    let result = value;
    for (let index = 0; index < value.length; index++) {
      const newValue = applyDefaultsRec(value[index], elementType);
      if (newValue !== value[index]) {
        if (result === value) {
          result = [...value];
        }
        result[index] = newValue;
      }
    }
    return result;
  }
  const shape = inner[shapeSymbol];
  if (!shape) {
    return value;
  }
  let result = value;
  for (const key in shape) {
    const subValue = result[key];
    const newValue = applyDefaultsRec(subValue, shape[key]);
    if (newValue !== subValue) {
      if (result === value) {
        result = Array.isArray(value) ? [...value] : { ...value };
      }
      result[key] = newValue;
    }
  }
  return result;
}

function anyType(): Type<any> {
  return makeType(function validateAny() {});
}

function booleanType(): Type<boolean> {
  return makeType(function validateBoolean(context: ValidationContext) {
    if (typeof context.value !== "boolean") {
      context.addIssue({ message: "value is not a boolean" });
    }
  });
}

function numberType<T extends number = number>(): Type<T> {
  return makeType(function validateNumber(context: ValidationContext) {
    if (typeof context.value !== "number") {
      context.addIssue({ message: "value is not a number" });
    }
  });
}

function stringType<T extends string = string>(): Type<T> {
  return makeType(function validateString(context: ValidationContext) {
    if (typeof context.value !== "string" && !(context.value instanceof String)) {
      context.addIssue({ message: "value is not a string" });
    }
  });
}

function arrayType(): Type<any[]>;
function arrayType<T>(): Type<T[]>;
function arrayType<T>(elementType: T): Type<StripBrands<T>[]>;
function arrayType(elementType?: any): any {
  const validate = makeType(function validateArray(context: ValidationContext) {
    if (!Array.isArray(context.value)) {
      context.addIssue({ message: "value is not an array" });
      return;
    }
    if (!elementType) {
      return;
    }

    for (let index = 0; index < context.value.length; index++) {
      context.withKey(index).validate(elementType);
    }
  });
  if (elementType) {
    validate[elementTypeSymbol] = elementType;
  }
  return validate;
}

export function constructorType<T extends Constructor>(constructor: T): Type<T> {
  return makeType(function validateConstructor(context: ValidationContext) {
    if (
      !(typeof context.value === "function") ||
      !(context.value === constructor || context.value.prototype instanceof constructor)
    ) {
      context.addIssue({ message: `value is not '${constructor.name}' or an extension` });
    }
  });
}

function customValidator<T>(
  type: T,
  validator: (value: StripBrands<T>) => boolean,
  errorMessage: string = "value does not match custom validation"
): Type<StripBrands<T>> {
  const isOptional = isOptionalType(type);
  const validate = makeType(function validateCustom(context: ValidationContext) {
    if (isOptional && context.value === undefined) {
      return;
    }
    const typeIssues: ValidationIssue[] = [];
    const typeContext = context.withIssues(typeIssues);
    typeContext.validate(type);
    if (typeIssues.length) {
      context.mergeIssues(typeIssues, typeContext.issueDepth);
      return;
    }
    if (!validator(context.value)) {
      context.addIssue({ message: errorMessage });
    }
  });
  validate[innerTypeSymbol] = type;
  if (isOptional) {
    validate[optionalSymbol] = true;
    const factory = getDefault(type);
    if (factory) {
      validate[defaultSymbol] = factory;
    }
  }
  return validate;
}

function functionType(): Type<(...parameters: any[]) => any>;
function functionType<const P extends unknown[]>(
  parameters: P
): Type<(...parameters: StripBrandsAll<P>) => void>;
function functionType<const P extends unknown[], R>(): Type<(...parameters: P) => R>;
function functionType<const P extends unknown[], R>(
  parameters: P,
  result: R
): Type<(...parameters: StripBrandsAll<P>) => StripBrands<R>>;
function functionType(parameters = [], result = undefined): any {
  return makeType(function validateFunction(context: ValidationContext) {
    if (typeof context.value !== "function") {
      context.addIssue({ message: "value is not a function" });
    }
  });
}

function instanceType<T extends Constructor>(constructor: T): Type<InstanceType<T>> {
  return makeType(function validateInstanceType(context: ValidationContext) {
    if (!(context.value instanceof constructor)) {
      context.addIssue({ message: `value is not an instance of '${constructor.name}'` });
    }
  });
}

function intersection<T extends any[]>(types: T): ShapeType<MergedShape<T>, IntersectionValue<T>> {
  const validate = makeType(function validateIntersection(context: ValidationContext) {
    for (const type of types) {
      context.validate(type);
    }
  });
  validate[intersectionSymbol] = types;
  validate.toShape = () => {
    const shape: Record<string, any> = {};
    for (const member of types as any[]) {
      const memberShape = typeof member.toShape === "function" ? member.toShape() : undefined;
      if (memberShape && !Array.isArray(memberShape)) {
        Object.assign(shape, memberShape);
      }
    }
    return shape;
  };
  return validate;
}

export type LiteralTypes = number | string | boolean | null | undefined;
function literalType<const T extends LiteralTypes>(literal: T): Type<T> {
  return makeType(function validateLiteral(context: ValidationContext) {
    if (context.value !== literal) {
      context.addIssue({
        message: `value is not equal to ${typeof literal === "string" ? `'${literal}'` : literal}`,
      });
    }
  });
}

function literalSelection<const T extends LiteralTypes>(literals: T[]): Type<T> {
  return union(literals.map(literalType)) as any;
}

function objectValidator(schema: any, isStrict: boolean) {
  const isShape = schema && !Array.isArray(schema);
  const keys: string[] = !schema ? [] : isShape ? Object.keys(schema) : schema;
  const known = new Set(keys);
  return function validateObject(context: ValidationContext) {
    const value = context.value;
    if (typeof value !== "object" || Array.isArray(value) || value === null) {
      context.addIssue({ message: "value is not an object" });
      return;
    }
    if (!schema) {
      return;
    }
    const missingKeys: string[] = [];
    for (const key of keys) {
      if (value[key] === undefined) {
        if (!isShape || !isOptionalType(schema[key])) {
          missingKeys.push(key);
        }
        continue;
      }
      if (isShape) {
        context.withKey(key).validate(schema[key]);
      }
    }
    if (missingKeys.length) {
      context.addIssue({
        message: "object value has missing keys",
        missingKeys,
      });
    }
    if (isStrict) {
      const unknownKeys = Object.keys(value).filter((key) => !known.has(key));
      if (unknownKeys.length) {
        context.addIssue({
          message: "object value has unknown keys",
          unknownKeys,
        });
      }
    }
  };
}

function objectType(): ShapeType<Record<string, any>, Record<string, any>>;
function objectType<const Keys extends string[]>(
  keys: Keys
): ShapeType<Keys, ResolveOptionalEntries<KeyedObject<Keys>>>;
function objectType<Shape extends {}>(): ShapeType<{}, ResolveOptionalEntries<Shape>>;
function objectType<Shape extends {}>(
  shape: Shape
): ShapeType<Shape, ResolveOptionalEntries<Shape>>;
function objectType(schema = {}): any {
  const validate = makeType(objectValidator(schema, false));
  if (!Array.isArray(schema)) {
    validate[shapeSymbol] = schema;
  }
  validate.toShape = () => schema;
  return validate;
}

function strictObjectType<const Keys extends string[]>(
  keys: Keys
): ShapeType<Keys, ResolveOptionalEntries<KeyedObject<Keys>>>;
function strictObjectType<Shape extends {}>(
  shape: Shape
): ShapeType<Shape, ResolveOptionalEntries<Shape>>;
function strictObjectType(schema: any): any {
  const validate = makeType(objectValidator(schema, true));
  if (!Array.isArray(schema)) {
    validate[shapeSymbol] = schema;
  }
  validate.toShape = () => schema;
  return validate;
}

function promiseType(): Type<Promise<void>>;
function promiseType<T>(type: T): Type<Promise<StripBrands<T>>>;
function promiseType(type?: any): any {
  return makeType(function validatePromise(context: ValidationContext) {
    if (!(context.value instanceof Promise)) {
      context.addIssue({ message: "value is not a promise" });
    }
  });
}

function recordType(): Type<Record<PropertyKey, any>>;
function recordType<V>(valueType: V): Type<Record<PropertyKey, StripBrands<V>>>;
function recordType(valueType?: any): any {
  return makeType(function validateRecord(context: ValidationContext) {
    if (
      typeof context.value !== "object" ||
      Array.isArray(context.value) ||
      context.value === null
    ) {
      context.addIssue({ message: "value is not an object" });
      return;
    }
    if (!valueType) {
      return;
    }
    for (const key of Object.keys(context.value)) {
      context.withKey(key).validate(valueType);
    }
  });
}

function tuple<const T extends unknown[]>(types: T): Type<StripBrandsAll<T>> {
  const validate = makeType(function validateTuple(context: ValidationContext) {
    if (!Array.isArray(context.value)) {
      context.addIssue({ message: "value is not an array" });
      return;
    }
    if (context.value.length !== types.length) {
      context.addIssue({ message: "tuple value does not have the correct length" });
      return;
    }
    for (let index = 0; index < types.length; index++) {
      context.withKey(index).validate(types[index]);
    }
  });
  validate[shapeSymbol] = types;
  return validate;
}

function union<T extends unknown[]>(types: T): Type<StripBrands<T[number]>> {
  return makeType(function validateUnion(context: ValidationContext) {
    const subIssues: ValidationIssue[] = [];
    let deepestIssues: ValidationIssue[] | null = null;
    let deepest = 0;
    for (const type of types) {
      const memberIssues: ValidationIssue[] = [];
      const subContext = context.withIssues(memberIssues);
      subContext.validate(type);
      if (!memberIssues.length) {
        return;
      }
      if (subContext.issueDepth > deepest) {
        deepest = subContext.issueDepth;
        deepestIssues = memberIssues;
      }
      subIssues.push(...memberIssues);
    }
    if (deepestIssues) {
      context.mergeIssues(deepestIssues, deepest);
      return;
    }
    context.addIssue({
      message: "value does not match union type",
      subIssues,
    });
  });
}

function reactiveValueType(): Type<ReactiveValue<any>>;
function reactiveValueType<T>(): Type<ReactiveValue<T>>;
function reactiveValueType<T>(type: T): Type<ReactiveValue<StripBrands<T>>>;
function reactiveValueType(type?: any): any {
  return makeType(function validateReactiveValue(context: ValidationContext) {
    if (typeof context.value !== "function" || !context.value[atomSymbol]) {
      context.addIssue({ message: "value is not a reactive value" });
    }
  });
}

function ref(): Type<HTMLElement | null>;
function ref<T extends Constructor<HTMLElement>>(type: T): Type<InstanceType<T> | null>;
function ref(type?: any): any {
  if (typeof HTMLElement === "undefined") {
    throw new OwlError("Cannot use ref in a non-DOM environment");
  }
  return union([literalType(null), elementType(type || HTMLElement)]);
}

function elementType(constructor: Constructor): Type<HTMLElement> {
  return makeType(function validateElement(context: ValidationContext) {
    const value = context.value;
    const realmConstructor = value?.ownerDocument?.defaultView?.[constructor.name];
    if (
      !(value instanceof constructor) &&
      !(typeof realmConstructor === "function" && value instanceof realmConstructor)
    ) {
      context.addIssue({ message: `value is not an instance of '${constructor.name}'` });
    }
  });
}

export const types = {
  and: intersection,
  any: anyType,
  array: arrayType,
  boolean: booleanType,
  constructor: constructorType,
  customValidator: customValidator,
  function: functionType,
  instanceOf: instanceType,
  literal: literalType,
  number: numberType,
  object: objectType,
  or: union,
  promise: promiseType,
  record: recordType,
  ref,
  selection: literalSelection,
  signal: reactiveValueType,
  strictObject: strictObjectType,
  string: stringType,
  tuple: tuple,
};
