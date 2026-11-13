"use client";
/**
 * The interactive half of the case page: progress at a glance, filters, keyboard navigation,
 * and optimistic dispositions that roll back when the server refuses. Every write still goes
 * through the Server Action and its checks; this only changes how fast the page feels.
 */
import { ArrowDownToLine, Keyboard, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useOptimistic, useState } from "react";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { ToastProvider, useToast } from "@/components/ui/toast";
import type { ReviewItem } from "@/lib/review/cases";
import { itemAnchor, itemTitle, label } from "@/lib/review/format";
import type { ItemState } from "@/lib/review/state";
import type { ActionResult, ReviewAction } from "./action-form";
import { ObjectionCard, type CardMode } from "./objection-card";

export interface CaseReviewProps {
  caseId: string;
  items: ReviewItem[];
  states: Record<string, ItemState>;
  dispose: ReviewAction;
  canAct: boolean;
}

type StatusFilter = "all" | "open" | "decided";
const VERB: Record<CardMode, string> = { resolve: "resolved", dismiss: "dismissed", reopen: "reopened" };

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

function focusCard(id: string) {
  const el = document.getElementById(itemAnchor(id));
  if (!el) return;
  el.focus({ preventScroll: true });
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
}

function Review({ caseId, items, states, dispose, canAct }: CaseReviewProps) {
  const toast = useToast();
  const [optimistic, setOptimistic] = useOptimistic(states, (cur, u: { id: string; state: ItemState }) => ({ ...cur, [u.id]: u.state }));
  const [modes, setModes] = useState<Record<string, CardMode | null>>({});
  const [status, setStatus] = useState<StatusFilter>("all");
  const [criterion, setCriterion] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [help, setHelp] = useState(false);

  const decided = items.filter((i) => optimistic[i.id]?.status !== "open").length;
  const criteria = useMemo(() => [...new Set(items.map((i) => i.criterion))], [items]);
  const visible = items.filter((i) => {
    const s = optimistic[i.id]?.status ?? "open";
    if (status === "open" && s !== "open") return false;
    if (status === "decided" && s === "open") return false;
    return criterion === null || i.criterion === criterion;
  });

  const setMode = useCallback((id: string, m: CardMode | null) => setModes((all) => ({ ...all, [id]: m })), []);

  const optimisticDispose = useCallback(async (form: FormData): Promise<ActionResult> => {
    const id = String(form.get("item_id"));
    const action = String(form.get("action")) as CardMode;
    setOptimistic({
      id,
      state: action === "reopen" ? { status: "open" } : { status: action === "resolve" ? "resolved" : "dismissed", note: String(form.get("note") ?? ""), actor: "you" },
    });
    return dispose(form);
  }, [dispose, setOptimistic]);

  const onDone = useCallback((id: string) => (result: ActionResult, mode: CardMode) => {
    if (result?.error) toast.error(result.error);
    else toast.ok(`${itemTitle(id)} ${VERB[mode]}.`);
  }, [toast]);

  const go = useCallback((id: string | undefined) => {
    if (!id) return;
    setFocused(id);
    focusCard(id);
  }, []);

  const nextOpen = useCallback(() => {
    const start = focused ? visible.findIndex((i) => i.id === focused) : -1;
    const ordered = [...visible.slice(start + 1), ...visible.slice(0, start + 1)];
    go(ordered.find((i) => optimistic[i.id]?.status === "open")?.id);
  }, [focused, visible, optimistic, go]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const at = focused ? visible.findIndex((i) => i.id === focused) : -1;
      if (e.key === "j") { e.preventDefault(); go(visible[Math.min(visible.length - 1, at + 1)]?.id); }
      else if (e.key === "k") { e.preventDefault(); go(visible[Math.max(0, at - 1)]?.id); }
      else if (e.key === "n") { e.preventDefault(); nextOpen(); }
      else if ((e.key === "r" || e.key === "d") && focused && canAct && optimistic[focused]?.status === "open") {
        e.preventDefault(); setMode(focused, e.key === "r" ? "resolve" : "dismiss");
      } else if (e.key === "?") { e.preventDefault(); setHelp((h) => !h); }
      else if (e.key === "Escape") { setHelp(false); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focused, visible, optimistic, canAct, go, nextOpen, setMode]);

  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors duration-[var(--dur-1)] ${active ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)]"}`;
  const count = (f: (s: string) => boolean) => items.filter((i) => f(optimistic[i.id]?.status ?? "open")).length;

  return (
    <section aria-label="Objections" className="min-w-0 space-y-4">
      <div className="z-20 -mx-2 rounded-b-2xl md:sticky md:top-14 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--paper)_88%,transparent)] px-2 pt-3 pb-3 backdrop-blur-md">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <h2 className="font-serif text-2xl">Objections and findings</h2>
          <p className="font-mono text-xs text-[var(--muted)]">
            <span className="sr-only">{decided} of {items.length} decided</span>
            <span aria-hidden="true"><AnimatedNumber value={decided} className="text-[var(--ink)]" /> of {items.length} decided</span>
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={nextOpen} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-3 py-1.5 text-sm hover:bg-[var(--card)]">
              <ArrowDownToLine aria-hidden="true" width={15} height={15} />Next open
            </button>
            <button type="button" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts" className="hidden h-8 w-8 md:inline-flex items-center justify-center rounded-lg text-[var(--muted)] hover:text-[var(--ink)]">
              <Keyboard aria-hidden="true" width={16} height={16} />
            </button>
          </div>
        </div>
        <div
          role="progressbar"
          aria-label="Review progress"
          aria-valuemin={0}
          aria-valuemax={items.length}
          aria-valuenow={decided}
          aria-valuetext={`${decided} of ${items.length} decided`}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--line)]"
        >
          <div className="h-full rounded-full bg-[var(--green)] transition-[width] duration-[var(--dur-3)] ease-[var(--ease-out)]" style={{ width: `${items.length ? (decided / items.length) * 100 : 0}%` }} />
        </div>
        <div className="-mx-2 mt-3 flex flex-nowrap gap-1.5 overflow-x-auto px-2 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0" role="group" aria-label="Filter">
          {([["all", "All", items.length], ["open", "Open", count((s) => s === "open")], ["decided", "Decided", count((s) => s !== "open")]] as const).map(([v, name, n]) => (
            <button key={v} type="button" aria-pressed={status === v} onClick={() => setStatus(v)} className={`${chip(status === v)} shrink-0`}>
              {name} <span className="font-mono">{n}</span>
            </button>
          ))}
          <span className="mx-1 w-px self-stretch bg-[var(--line)]" aria-hidden="true" />
          {criteria.map((c) => (
            <button key={c} type="button" aria-pressed={criterion === c} onClick={() => setCriterion((cur) => (cur === c ? null : c))} className={`${chip(criterion === c)} shrink-0`}>
              {label(c)} <span className="font-mono">{items.filter((i) => i.criterion === c).length}</span>
            </button>
          ))}
        </div>
      </div>

      {!canAct && (
        <p className="rounded-lg border border-[var(--amber)] bg-[var(--amber-soft)] px-3 py-2 text-sm text-[var(--amber)]">
          Name yourself under “Reviewing as” to resolve or dismiss items; every action is logged under that name.
        </p>
      )}

      {visible.map((item) => (
        <ObjectionCard
          key={item.id}
          caseId={caseId}
          item={item}
          state={optimistic[item.id] ?? { status: "open" }}
          dispose={optimisticDispose}
          canAct={canAct}
          mode={modes[item.id] ?? null}
          onModeChange={(m) => setMode(item.id, m)}
          onDone={onDone(item.id)}
        />
      ))}
      {visible.length === 0 && <p className="py-8 text-center text-sm text-[var(--muted)]">Nothing matches this filter.</p>}

      {help && (
        <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="fixed inset-0 z-[55] flex items-center justify-center bg-black/30 p-4" onClick={() => setHelp(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-[var(--line)] bg-[var(--raised)] p-6 shadow-[var(--shadow-2)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-xl">Keyboard shortcuts</h2>
              <button type="button" onClick={() => setHelp(false)} aria-label="Close" className="text-[var(--muted)] hover:text-[var(--ink)]"><X aria-hidden="true" width={18} height={18} /></button>
            </div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {[["j / k", "next / previous item"], ["n", "next open item"], ["r", "resolve the focused item"], ["d", "dismiss the focused item"], ["Esc", "cancel a note, close this"], ["?", "show these shortcuts"]].map(([k, v]) => (
                <div key={k} className="contents"><dt><kbd className="rounded border border-[var(--line-strong)] px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dt><dd className="text-[var(--muted)]">{v}</dd></div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </section>
  );
}

export function CaseReview(props: CaseReviewProps) {
  return (
    <ToastProvider>
      <Review {...props} />
    </ToastProvider>
  );
}
