/**
 * Directional page transitions (React <ViewTransition>): links tagged nav-forward slide the new
 * page in from the right, nav-back from the left; untagged navigations (browser back, refresh,
 * Suspense reveals) do not slide. Wrap each page, not the layout: layouts persist.
 */
import { ViewTransition, type ReactNode } from "react";

const DIRECTION = { "nav-forward": "nav-forward", "nav-back": "nav-back", default: "none" } as const;

export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter={DIRECTION} exit={DIRECTION} default="none">
      {children}
    </ViewTransition>
  );
}

/** Skeleton out, content in: a soft reveal when streamed data arrives. */
export function Reveal({ children }: { children: ReactNode }) {
  return <ViewTransition enter="reveal" default="none">{children}</ViewTransition>;
}
export function SkeletonExit({ children }: { children: ReactNode }) {
  return <ViewTransition exit="skeleton-out" default="none">{children}</ViewTransition>;
}
