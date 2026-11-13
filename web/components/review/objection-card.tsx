"use client";
/**
 * One AI claim to dispose of. Open items show the claim and a compact action row; choosing
 * Resolve or Dismiss opens an inline note (the note is required: the server checks it too).
 * Decided items fold to a one-line summary of who decided and why, with the claim one click away.
 * Works on its own, or controlled by <CaseReview> (mode, keyboard, optimistic status).
 */
import { Check, ChevronDown, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { KindIcon, StatusIcon } from "@/components/ui/icons";
import type { ReviewItem } from "@/lib/review/cases";
import { citeHref, itemAnchor, itemTitle, label, pct } from "@/lib/review/format";
import type { ItemState } from "@/lib/review/state";
import type { ActionResult, ReviewAction } from "./action-form";

export type CardMode = "resolve" | "dismiss" | "reopen";

const KIND = {
  prong: { tag: "AI objection", tone: "text-[var(--seal)]" },
  waiver: { tag: "Waiver check", tone: "text-[var(--amber)]" },
  manual: { tag: "Not reviewed", tone: "text-[var(--amber)]" },
} as const;

const CONFIRM: Record<CardMode, string> = { resolve: "Confirm resolve", dismiss: "Confirm dismiss", reopen: "Confirm reopen" };

function riskTone(r: number) {
  return r >= 0.7 ? "bg-[var(--red-soft)] text-[var(--red)]" : r >= 0.4 ? "bg-[var(--amber-soft)] text-[var(--amber)]" : "bg-[var(--green-soft)] text-[var(--green)]";
}

function EvidenceLinks({ ids, source }: { ids: string[]; source: boolean }) {
  return (
    <p className="mt-3 font-mono text-xs text-[var(--muted)]">
      Evidence:{" "}
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ", "}
          <a href={`#artifact-${id}`} data-source={source ? "" : undefined} className="rounded underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]">
            {id}
          </a>
        </span>
      ))}
    </p>
  );
}

function Body({ caseId, item }: { caseId: string; item: ReviewItem }) {
  if (item.kind === "prong") {
    return (
      <>
        <p className="measure mt-1 text-sm text-[var(--muted)]">Tests whether {item.test}.</p>
        <p className="measure mt-3 leading-relaxed">{item.objection}</p>
        <ul className="mt-4 space-y-2">
          {item.citations.map((c, n) => (
            <li key={`${c.chunk_id}:${n}`} className="measure rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm">
              <a href={citeHref(caseId, item.id, n)} data-source="" className="font-mono text-xs text-[var(--accent)] underline underline-offset-2">
                {c.decision_id} · passage {c.chunk_id}
              </a>
              <q className="mt-1 block text-[var(--muted)] italic">{c.quote}</q>
            </li>
          ))}
        </ul>
        <EvidenceLinks ids={item.artifact_ids} source={false} />
      </>
    );
  }
  if (item.kind === "waiver") {
    return (
      <>
        <p className="measure mt-3 leading-relaxed">{item.message}</p>
        <EvidenceLinks ids={item.artifact_ids} source />
      </>
    );
  }
  return (
    <>
      <p className="measure mt-1 text-sm text-[var(--muted)]">Tests whether {item.test}.</p>
      <p className="measure mt-3 leading-relaxed">
        The examiner could not ground a review of this prong in AAO reasoning ({label(item.reason)}), so it shows no
        objection. Review the evidence for this prong yourself.
      </p>
      <EvidenceLinks ids={item.artifact_ids} source />
    </>
  );
}

const btn = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors duration-[var(--dur-1)] disabled:cursor-not-allowed disabled:opacity-40";

export interface ObjectionCardProps {
  caseId: string;
  item: ReviewItem;
  state: ItemState;
  dispose: ReviewAction;
  canAct?: boolean;
  mode?: CardMode | null; // controlled by <CaseReview>; uncontrolled when omitted
  onModeChange?: (mode: CardMode | null) => void;
  onDone?: (result: ActionResult, mode: CardMode) => void;
}

export function ObjectionCard({ caseId, item, state, dispose, canAct = true, mode: controlled, onModeChange, onDone }: ObjectionCardProps) {
  const [ownMode, setOwnMode] = useState<CardMode | null>(null);
  const mode = controlled !== undefined ? controlled : ownMode;
  const setMode = (m: CardMode | null) => (onModeChange ? onModeChange(m) : setOwnMode(m));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showClaim, setShowClaim] = useState(false);

  const open = state.status === "open";
  const kind = KIND[item.kind];
  const noteId = `note-${itemAnchor(item.id)}`;
  const formOpen = mode !== null && (mode === "reopen" ? !open : open);

  async function submit(form: FormData) {
    if (!mode) return;
    const used = mode;
    setError(null);
    const result = await dispose(form);
    if (result?.error) setError(result.error); // the note stays; the server state rolls back
    else {
      setDraft("");
      setMode(null);
    }
    onDone?.(result, used);
  }

  return (
    <article
      id={itemAnchor(item.id)}
      tabIndex={-1}
      data-testid="objection"
      data-item-id={item.id}
      data-status={state.status}
      className={`group scroll-mt-32 rounded-2xl border bg-[var(--card)] p-5 shadow-[var(--shadow-1)] transition-[border-color,box-shadow,opacity] duration-[var(--dur-2)] ease-[var(--ease-out)] focus:outline-none focus-visible:border-[var(--accent)] focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] ${open ? "border-[var(--line)]" : "border-[var(--line)] opacity-90"}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] tracking-widest uppercase ${kind.tone}`}>
          <KindIcon kind={item.kind} decorative size={14} />
          {kind.tag}
        </span>
        <h3 className="font-serif text-xl leading-tight">{itemTitle(item)}</h3>
        <span className="ml-auto flex items-center gap-2">
          {item.kind === "prong" && (
            <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${riskTone(item.facially_met ? item.risk : Math.max(item.risk, 0.8))}`}>
              risk {pct(item.risk)}%{item.facially_met ? "" : " · not facially met"}
            </span>
          )}
          {!open && <StatusIcon status={state.status} size={18} className={state.status === "resolved" ? "text-[var(--green)]" : "text-[var(--muted)]"} />}
        </span>
      </header>

      {open ? (
        <Body caseId={caseId} item={item} />
      ) : (
        <div className="mt-3">
          <p className={`text-sm font-medium ${state.status === "resolved" ? "text-[var(--green)]" : "text-[var(--muted)]"}`}>
            {state.status === "resolved" ? "Resolved" : "Dismissed"} by {state.actor}
          </p>
          <p className="measure mt-1 text-sm">{state.note}</p>
          <button
            type="button"
            onClick={() => setShowClaim((s) => !s)}
            aria-expanded={showClaim}
            className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-[var(--muted)] hover:text-[var(--ink)]"
          >
            <ChevronDown aria-hidden="true" width={14} height={14} className={`transition-transform duration-[var(--dur-2)] ${showClaim ? "rotate-180" : ""}`} />
            {showClaim ? "Hide the claim" : "Show the claim"}
          </button>
          <div className={`grid transition-[grid-template-rows] duration-[var(--dur-3)] ease-[var(--ease-out)] ${showClaim ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
            <div className="overflow-hidden" inert={!showClaim}>
              <Body caseId={caseId} item={item} />
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-[var(--line)] pt-3">
        {!formOpen && (
          <div className="flex flex-wrap items-center gap-2">
            {open ? (
              <>
                <button type="button" disabled={!canAct} onClick={() => setMode("resolve")} className={`${btn} bg-[var(--ink)] text-[var(--paper)] hover:opacity-90`}>
                  <Check aria-hidden="true" width={15} height={15} />Resolve
                </button>
                <button type="button" disabled={!canAct} onClick={() => setMode("dismiss")} className={`${btn} border border-[var(--line-strong)] hover:bg-[var(--paper)]`}>
                  <X aria-hidden="true" width={15} height={15} />Dismiss
                </button>
              </>
            ) : (
              <button type="button" disabled={!canAct} onClick={() => setMode("reopen")} className={`${btn} border border-[var(--line-strong)] hover:bg-[var(--paper)]`}>
                <RotateCcw aria-hidden="true" width={15} height={15} />Reopen
              </button>
            )}
          </div>
        )}
        {formOpen && mode && (
          <form action={submit} className="space-y-2">
            <input type="hidden" name="item_id" value={item.id} />
            <input type="hidden" name="action" value={mode} />
            <label htmlFor={noteId} className="block font-mono text-xs text-[var(--muted)]">
              {mode === "reopen" ? "Attorney note (why reopen)" : `Attorney note (why ${mode})`}
            </label>
            <textarea
              id={noteId}
              name="note"
              required
              minLength={3}
              maxLength={2000}
              rows={2}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMode(null); } }}
              className="measure block w-full rounded-lg border border-[var(--line-strong)] bg-[var(--paper)] p-2.5 text-sm"
            />
            <div className="flex items-center gap-2">
              <button className={`${btn} bg-[var(--ink)] text-[var(--paper)] hover:opacity-90`}>{CONFIRM[mode]}</button>
              <button type="button" onClick={() => { setMode(null); setError(null); }} className={`${btn} text-[var(--muted)] hover:text-[var(--ink)]`}>
                Cancel
              </button>
            </div>
            {error && <p role="alert" className="text-sm text-[var(--red)]">{error}</p>}
          </form>
        )}
      </div>
    </article>
  );
}
