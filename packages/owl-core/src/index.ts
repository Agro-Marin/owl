// Errors
export { OwlError } from "./owl_error";

// Status constants
export { STATUS } from "./status";

// Utilities
export { batched } from "./batched";

// Scope / lifetime
export { Scope, scopeStack, getScope, useScope, isAbortError, makeAbortError } from "./scope";

// Reactivity: proxy
export { proxy, observe, markRaw, toRaw, readArrayItems } from "./proxy";

// Reactivity: computations (core tracking primitives)
export {
  untrack,
  type Equals,
  type ReactiveValue,
  type ReadonlyReactiveValue,
  type Atom,
  type ComputationAtom,
  ComputationState,
  atomSymbol,
  createComputation,
  getCurrentComputation,
  setComputation,
  runTracked,
  removeSources,
  disposeComputation,
  hasObservers,
  observersOf,
  sourcesOf,
  type Link,
} from "./computations";

// Reactivity: signal
export { signal, type Signal } from "./signal";

// Reactivity: computed
export { computed } from "./computed";

// Reactivity: effect
export { effect, immediateEffect, type EffectOptions } from "./effect";

// Debug logging
export {
  debug,
  debugLog,
  debugNow,
  DEBUG_CHANNELS,
  setDebug,
  setDebugSink,
  type DebugChannel,
  type DebugSink,
} from "./debug";

// Reactivity: asyncComputed
export {
  asyncComputed,
  type AsyncComputed,
  type AsyncComputedContext,
  type AsyncComputedOptions,
} from "./async_computed";

// Validation
export {
  assertType,
  validateType,
  type ValidationContext,
  type ValidationIssue,
} from "./validation";

// Type validators (`t` is the documented short alias of `types`)
export {
  types,
  types as t,
  constructorType,
  applyDefaults,
  getDefault,
  type Constructor,
  type GetDefaultedKeys,
  type GetOptionalEntries,
  type KeyedObject,
  type LiteralTypes,
  type Optional,
  type PrettifyShape,
  type ResolveObjectType,
  type ResolveOptionalEntries,
  type ResolveReaderObjectType,
  type ShapeType,
  type StripBrands,
  type Type,
  type UnionToIntersection,
  type WithDefault,
  // Phantom brand symbols carried by the public `Type`/`Optional`/`WithDefault`
  // types. Exported (type-only) so downstream projects can name them when
  // emitting declaration files, mirroring `isProps` (see owl#1958).
  type hasDefault,
  type isOptional,
  type typeBrand,
} from "./types";

// Registry / Resource
export { Registry } from "./registry";
export { Resource, type ResourceAddOptions } from "./resource";

export { EventModifier } from "./event_modifiers";

// Plugin system
export { Plugin, PluginManager, startPlugins, type PluginConstructor } from "./plugin_manager";

// Hooks
export {
  // not a hook, used by the runtime's `mainEventHandler`
  setCurrentEvent,
  useApp,
  useEffect,
  useListener,
  useOnChange,
} from "./hooks";

export { onWillDestroy, onWillStart } from "./lifecycle_hooks";

export { useConfig, config, usePlugin, plugin, type PluginInstance } from "./plugin_hooks";

export { EventBus, htmlEscape, Markup, markup, shallowEqual } from "./utils";
