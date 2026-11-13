"use client";
/**
 * The review memo, read before it is exported: rendered from plain blocks (never raw HTML),
 * printable as a clean document ("Save as PDF"), downloadable from the gated export route.
 */
import { Download, Printer, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { memoBlocks } from "@/lib/review/memo-view";

export function MemoPreview({ memo, exportHref, onClose }: { memo: string; exportHref: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // rendered under <body>: the sticky sidebar it is opened from would otherwise trap its z-index
  return createPortal(
    <div className="memo-backdrop fixed inset-0 z-[55] flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-10" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Review memo" tabIndex={-1} onClick={(e) => e.stopPropagation()} className="pop-in w-full max-w-3xl focus:outline-none">
        <div className="memo-toolbar sticky top-0 z-10 mb-3 flex items-center gap-2 rounded-xl bg-[var(--raised)] px-4 py-2 shadow-[var(--shadow-2)]">
          <span className="font-mono text-xs text-[var(--muted)]">Preview: nothing is logged until you export</span>
          <button type="button" onClick={() => window.print()} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-2.5 py-1.5 text-xs hover:bg-[var(--card)]">
            <Printer aria-hidden="true" width={14} height={14} />Print or save as PDF
          </button>
          <a href={exportHref} download className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ink)] px-2.5 py-1.5 text-xs text-[var(--paper)]">
            <Download aria-hidden="true" width={14} height={14} />Export
          </a>
          <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--muted)] hover:text-[var(--ink)]"><X aria-hidden="true" width={16} height={16} /></button>
        </div>
        <article className="memo-print rounded-xl bg-[var(--raised)] px-8 py-10 shadow-[var(--shadow-2)] sm:px-14">
          {memoBlocks(memo).map((b, i) => {
            if (b.kind === "p") return (
              <p key={i} className="measure mt-3 leading-relaxed">
                {b.parts.map((part, j) => (part.bold ? <strong key={j} className="font-medium">{part.text}</strong> : <span key={j}>{part.text}</span>))}
              </p>
            );
            if (b.kind === "ul") return (
              <ul key={i} className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-[var(--muted)]">
                {b.items.map((text, j) => <li key={j}>{text}</li>)}
              </ul>
            );
            return b.kind === "h1"
              ? <h1 key={i} className="font-serif text-3xl leading-tight">{b.text}</h1>
              : <h2 key={i} className="mt-8 border-t border-[var(--line)] pt-5 font-serif text-xl">{b.text}</h2>;
          })}
        </article>
      </div>
    </div>,
    document.body,
  );
}
