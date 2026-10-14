import type {} from "./build-env";
import { version } from "./version";
import {
  config,
  createBlock,
  html,
  list,
  mount as blockMount,
  multi,
  patch,
  remove,
  text,
  toggler,
} from "./blockdom";
export { Resource, Registry } from "@odoo/owl-core";

export const blockDom = {
  config,
  mount: blockMount,
  patch,
  remove,
  list,
  multi,
  text,
  toggler,
  createBlock,
  html,
};
export { App, mount } from "./app";
export { xml, TemplateSet, globalTemplates } from "./template_set";
export type { TemplateCompiler, TemplateSetConfig } from "./template_set";
export { Component } from "./component";
export type { ComponentConstructor } from "./component";
export { ErrorBoundary } from "./error_boundary";
export { Portal } from "./portal";
export { Suspense } from "./suspense";
export { useProps, props } from "./props";
export type { GetProps, isProps } from "./props";
export { status } from "./status";
export {
  asyncComputed,
  batch,
  computed,
  effect,
  immediateEffect,
  markRaw,
  observe,
  proxy,
  selector,
  signal,
  toRaw,
  untrack,
  type AsyncComputed,
  type AsyncComputedContext,
  type AsyncComputedOptions,
  type Equals,
  type ReactiveValue,
  type ReadonlyReactiveValue,
  type SelectorOptions,
  type Signal,
} from "@odoo/owl-core";
export { useEffect, useListener, useOnChange, useApp } from "./hooks";
export { batched, EventBus, htmlEscape, shallowEqual, whenReady, markup } from "./utils";
export {
  onWillStart,
  onMounted,
  onWillUnmount,
  onWillUpdateProps,
  onWillPatch,
  onPatched,
  onWillDestroy,
  onError,
} from "./lifecycle_hooks";
export { applyDefaults, assertType, getDefault, validateType } from "@odoo/owl-core";
export { types, types as t } from "./types";
export type {
  hasDefault,
  isOptional,
  Optional,
  ShapeType,
  StripBrands,
  Type,
  typeBrand,
  WithDefault,
} from "@odoo/owl-core";
export { OwlError } from "@odoo/owl-core";
export { useConfig, config, usePlugin, plugin, providePlugins } from "./plugin_hooks";
export type { PluginInstance } from "./plugin_hooks";
export { Plugin } from "@odoo/owl-core";
export type { PluginConstructor } from "@odoo/owl-core";
export { getScope, isAbortError, Scope, useScope, type ScopeApp } from "@odoo/owl-core";
export { DEBUG_CHANNELS, setDebug, setDebugSink } from "@odoo/owl-core";
export type { DebugChannel, DebugSink, EffectOptions } from "@odoo/owl-core";

export const __info__: Record<string, string> = {
  version,
  date: __BUILD_DATE__,
  hash: __BUILD_HASH__,
  url: "https://github.com/odoo/owl",
};
