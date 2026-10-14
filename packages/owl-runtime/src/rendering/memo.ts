import { OwlError } from "@odoo/owl-core";
import type { VNode } from "../blockdom";
import type { ComponentNode } from "../component_node";
import { STATUS } from "../status";

export interface MemoContent {
  children: string[];
  sites: string[];
}

export interface MemoEntry {
  deps: unknown[];
  vnodes: VNode[];
  index: number;
  content: MemoContent | null;
}
export type MemoSite = Map<unknown, MemoEntry>;

let collected: MemoContent | null = null;

export function memoPrevious(node: ComponentNode, site: string): MemoSite | undefined {
  return node.previousMemos?.get(site);
}

export function memoKeep(node: ComponentNode, site: string, entries: MemoSite) {
  (node.memos ??= new Map()).set(site, entries);
  if (collected !== null) {
    collected.sites.push(site);
  }
}

export function memoHit(
  previous: MemoSite | undefined,
  key: unknown,
  deps: unknown[],
  node: ComponentNode
): MemoEntry | undefined {
  if (!Array.isArray(deps)) {
    throw new OwlError(`t-memo expects an array of dependencies, got ${typeof deps}`);
  }
  const entry = previous?.get(key);
  if (entry === undefined || node.fiber!.deep) {
    return undefined;
  }
  const previousDeps = entry.deps;
  const length = deps.length;
  if (previousDeps.length !== length) {
    return undefined;
  }
  for (let i = 0; i < length; i++) {
    if (!Object.is(previousDeps[i], deps[i])) {
      return undefined;
    }
  }
  const content = entry.content;
  if (content !== null) {
    const committed = node.childMap;
    const children = content.children;
    for (const childKey of children) {
      const child = committed?.get(childKey);
      if (child === undefined || child.status !== STATUS.MOUNTED || child.forceNextRender) {
        return undefined;
      }
    }
    if (children.length) {
      const childrenMap = (node.fiber!.childrenMap ||= new Map());
      for (const childKey of children) {
        childrenMap.set(childKey, committed!.get(childKey)!);
      }
    }
    const previousSites = node.previousMemos;
    for (const site of content.sites) {
      const entries = previousSites?.get(site);
      if (entries !== undefined) {
        (node.memos ??= new Map()).set(site, entries);
      }
    }
    if (collected !== null) {
      collected.children.push(...children);
      collected.sites.push(...content.sites);
    }
  }
  return entry;
}

export function memoBegin(): MemoContent | null {
  const outer = collected;
  collected = { children: [], sites: [] };
  return outer;
}

export function memoEnd(outer: MemoContent | null): MemoContent {
  const content = collected!;
  collected = outer;
  if (outer !== null) {
    outer.children.push(...content.children);
    outer.sites.push(...content.sites);
  }
  return content;
}

export function memoCollectChild(key: string) {
  if (collected !== null) {
    collected.children.push(key);
  }
}

export function memoSuspend(): MemoContent | null {
  const outer = collected;
  collected = null;
  return outer;
}

export function memoResume(outer: MemoContent | null) {
  collected = outer;
}
