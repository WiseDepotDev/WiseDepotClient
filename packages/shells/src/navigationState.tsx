import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { ScreenParams } from '@wise/features';
import {
  DOMAINS,
  SCAN_TARGET_METHOD,
  destinationOf,
  findLeafByMethod,
  type DomainId,
  type NavLeaf,
} from './navigation.js';

export interface ShellCrumb {
  readonly leaf: NavLeaf;
  readonly params?: ScreenParams | undefined;
}

export interface ShellNavigation {
  readonly domain: DomainId;
  readonly root: (typeof DOMAINS)[number];
  readonly leaf: NavLeaf;
  readonly stack: readonly ShellCrumb[];
  readonly top: ShellCrumb | undefined;
  readonly shown: ShellCrumb;
  readonly switchDomain: (id: DomainId) => void;
  readonly goRoot: (next: NavLeaf, nextDomain?: DomainId) => void;
  readonly onNavigate: (to: { method: string; params?: ScreenParams | undefined }) => void;
  readonly onScan: (code: string) => void;
  readonly pop: () => void;
}

export const NavigationContext = createContext<ShellNavigation | null>(null);

export function ShellNavigationProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [domain, setDomain] = useState<DomainId>('overview');
  const [leaf, setLeaf] = useState<NavLeaf>(DOMAINS[0]!.children[0]!);
  const [stack, setStack] = useState<readonly ShellCrumb[]>([]);
  const root = DOMAINS.find((item) => item.id === domain) ?? DOMAINS[0]!;
  const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
  const shown = top ?? { leaf, params: undefined as ScreenParams | undefined };

  const switchDomain = useCallback((id: DomainId): void => {
    const next = DOMAINS.find((item) => item.id === id);
    if (!next) {
      return;
    }
    setDomain(id);
    setLeaf(next.children[0]!);
    setStack([]);
  }, []);

  const goRoot = useCallback((next: NavLeaf, nextDomain?: DomainId): void => {
    if (nextDomain !== undefined) {
      setDomain(nextDomain);
    }
    setLeaf(next);
    setStack([]);
  }, []);

  const onNavigate = useCallback((to: { method: string; params?: ScreenParams | undefined }): void => {
    const dest = destinationOf(to.method);
    if (!dest) {
      console.warn(`[shell] 收到未知的导航目标：${to.method}`);
      return;
    }
    setStack((previous) => [
      ...previous,
      { leaf: { id: dest.method, label: dest.label, primaryMethod: dest.method }, params: to.params },
    ]);
  }, []);

  const onScan = useCallback((code: string): void => {
    const target = findLeafByMethod(SCAN_TARGET_METHOD);
    const dest = destinationOf(SCAN_TARGET_METHOD);
    if (target && !dest) {
      setDomain(target.domain);
      setLeaf(target.leaf);
      setStack([]);
      return;
    }
    if (!dest) {
      return;
    }
    setStack((previous) => [
      ...previous,
      { leaf: { id: dest.method, label: dest.label, primaryMethod: dest.method }, params: { code } },
    ]);
  }, []);

  const value: ShellNavigation = {
    domain,
    root,
    leaf,
    stack,
    top,
    shown,
    switchDomain,
    goRoot,
    onNavigate,
    onScan,
    pop: () => setStack((previous) => previous.slice(0, -1)),
  };

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useShellNavigation(): ShellNavigation {
  const value = useContext(NavigationContext);
  if (!value) {
    throw new Error('useShellNavigation must be used inside ShellNavigationProvider');
  }
  return value;
}
