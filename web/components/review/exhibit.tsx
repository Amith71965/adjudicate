"use client";
/**
 * Exhibit preview. An evidence link ("Evidence: A02") opens the exhibit as a document sheet:
 * what it is, what it is claimed for, and which AI findings name it. Without a provider (a card
 * rendered on its own) the link is a plain jump to the evidence matrix row.
 */
import { FileText, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import type { Case, ReviewItem } from "@/lib/review/cases";
import { itemAnchor, itemTitle, label } from "@/lib/review/format";

const ExhibitContext = createContext<((id: string) => void) | null>(null);

export const ExhibitProvider = ({ open, children }: { open: (id: string) => void; children: ReactNode }) => (
  <ExhibitContext.Provider value={open}>{children}</ExhibitContext.Provider>
);

export function EvidenceLink({ id, source }: { id: string; source: boolean }) {
  const open = useContext(ExhibitContext);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!open || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    history.replaceState(null, "", `#artifact-${id}`);
    open(id);
  };
  return (
    <a href={`#artifact-${id}`} onClick={onClick} data-source={source ? "" : undefined} className="rounded underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]">
      {id}
    </a>
  );
}

export function ExhibitDialog({ artifact, items, onClose }: { artifact: Case["artifacts"][number]; items: ReviewItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const named = items.filter((i) => i.artifact_ids.includes(artifact.id));
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`Exhibit ${artifact.id}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="pop-in w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--raised)] shadow-[var(--shadow-2)] focus:outline-none"
      >
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-6 py-3 font-mono text-[11px] tracking-widest text-[var(--muted)] uppercase">
          <FileText aria-hidden="true" width={14} height={14} />
          Exhibit {artifact.id} · {artifact.kind}
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-[var(--muted)] hover:text-[var(--ink)]">
            <X aria-hidden="true" width={16} height={16} />
          </button>
        </div>
        <div className="px-6 py-5">
          <h2 className="font-serif text-2xl leading-tight">{artifact.title}</h2>
          <p className="measure mt-3 leading-relaxed">{artifact.description}</p>
          <dl className="mt-5 grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
            <dt className="text-[var(--muted)]">Claimed for</dt>
            <dd>{artifact.claimed_criterion ? label(artifact.claimed_criterion) : <span className="text-[var(--amber)]">not claimed</span>}</dd>
            <dt className="text-[var(--muted)]">Named by</dt>
            <dd className="space-y-1">
              {named.length === 0 ? <span className="text-[var(--muted)]">no finding</span> : named.map((i) => (
                <a key={i.id} href={`#${itemAnchor(i.id)}`} onClick={onClose} className="block underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]">{itemTitle(i)}</a>
              ))}
            </dd>
          </dl>
          <a href={`#artifact-${artifact.id}`} onClick={onClose} className="mt-6 inline-block font-mono text-xs text-[var(--accent)] underline underline-offset-2">
            Show in the evidence matrix
          </a>
        </div>
      </div>
    </div>
  );
}
