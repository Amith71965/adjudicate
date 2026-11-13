"use client";
/**
 * Directional page transitions (React <ViewTransition>): links tagged nav-forward slide the new
 * page in from the right, nav-back from the left; untagged navigations (browser back, refresh,
 * Suspense reveals) do not slide. Wrap each page, not the layout: layouts persist.
 */
import { useSyncExternalStore, ViewTransition, type ReactNode } from "react";

const DIRECTION = { "nav-forward": "nav-forward", "nav-back": "nav-back", default: "none" } as const;

export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter={DIRECTION} exit={DIRECTION} default="none">
      {children}
    </ViewTransition>
  );
}

const noSubscribe = () => () => {};
/** False while rendering on the server and hydrating; true for anything rendered on the client after. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/**
 * Skeleton out, content in: a soft reveal when data arrives after a client navigation. Not on
 * the first, server-streamed load: there a reveal marker makes React's streaming runtime run a
 * document-wide view transition that holds the first paint for fonts and images.
 */
export function Reveal({ children }: { children: ReactNode }) {
  return <ViewTransition enter={useHydrated() ? "reveal" : "none"} default="none">{children}</ViewTransition>;
}
export function SkeletonExit({ children }: { children: ReactNode }) {
  return <ViewTransition exit={useHydrated() ? "skeleton-out" : "none"} default="none">{children}</ViewTransition>;
}
