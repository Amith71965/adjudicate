"use client";
/**
 * The AAO passage a citation points to, in full, with the quoted words marked. A modal dialog:
 * it takes focus when it opens and Escape closes it, so keyboard and screen-reader users land
 * in the passage, not behind it. Opening, closing and stepping between an item's citations are
 * client-side navigations (no reload); the page wraps the drawer in a slide-in view transition.
 */
import { ArrowLeft, ArrowRight, Check, Copy, FileSearch, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ProngItem } from "@/lib/review/cases";
import { citeHref, decisionDate, label } from "@/lib/review/format";
import { locateQuote, type Passage } from "@/lib/review/store";

interface Props {
  passage: Passage;
  quote: string;
  closeHref: string;
  caseId?: string;
  item?: ProngItem; // with n: enables previous/next citation within the item
  n?: number;
}

export function PassageDrawer({ passage, quote, closeHref, caseId, item, n }: Props) {
  const at = locateQuote(passage.body, quote);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current?.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const safeUrl = /^https:\/\//.test(passage.url); // corpus data, but never an href it shouldn't be
  const date = decisionDate(passage.decision_id);
  const nav = caseId && item && n !== undefined ? { total: item.citations.length, prev: n > 0 ? citeHref(caseId, item.id, n - 1) : null, next: n < item.citations.length - 1 ? citeHref(caseId, item.id, n + 1) : null } : null;
  const viewer = `/decisions/${passage.decision_id}?${new URLSearchParams({ q: quote, chunk: String(passage.chunk_id), back: caseId && item && n !== undefined ? citeHref(caseId, item.id, n).replace("#passage", "") : closeHref })}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(`“${quote}” (${passage.decision_id}, AAO${date ? `, ${date}` : ""})`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false); // clipboard blocked: the quote stays selectable in the passage
    }
  }

  const pill = "inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-2.5 py-1.5 text-xs hover:bg-[var(--card)]";
  return (
    <>
      <Link href={closeHref} scroll={false} aria-hidden tabIndex={-1} className="fixed inset-0 z-40 bg-black/25" />
      <aside
        ref={dialog}
        id="passage"
        role="dialog"
        aria-modal="true"
        aria-label="AAO passage"
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-y-auto border-l border-[var(--line)] bg-[var(--paper)] p-6 shadow-2xl focus:outline-none"
      >
        <div className="flex items-center gap-3">
          <p className="font-mono text-[11px] tracking-widest text-[var(--muted)] uppercase">
            {nav ? `Citation ${n! + 1} of ${nav.total}` : `AAO passage ${passage.chunk_id}`}
          </p>
          {nav && (
            <span className="flex gap-1">
              {nav.prev && <Link href={nav.prev} scroll={false} aria-label="Previous citation" className="rounded p-1 text-[var(--muted)] hover:text-[var(--ink)]"><ArrowLeft aria-hidden="true" width={15} height={15} /></Link>}
              {nav.next && <Link href={nav.next} scroll={false} aria-label="Next citation" className="rounded p-1 text-[var(--muted)] hover:text-[var(--ink)]"><ArrowRight aria-hidden="true" width={15} height={15} /></Link>}
            </span>
          )}
          <Link ref={close} href={closeHref} scroll={false} className="ml-auto inline-flex items-center gap-1 font-mono text-sm underline">
            <X aria-hidden="true" width={14} height={14} />Close
          </Link>
        </div>
        <h2 className="mt-3 font-serif text-2xl">
          {safeUrl ? (
            <a href={passage.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              {passage.decision_id}
            </a>
          ) : (
            passage.decision_id
          )}
        </h2>
        <p className="mt-1 font-mono text-xs text-[var(--muted)]">
          {date && `${date} · `}{label(passage.section_kind)}{passage.criterion ? ` · ${label(passage.criterion)}` : ""}
          {safeUrl ? " · opens the USCIS PDF" : ""}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={viewer} transitionTypes={["nav-forward"]} className={pill}><FileSearch aria-hidden="true" width={14} height={14} />Open in decision</Link>
          <button type="button" onClick={copy} className={pill}>
            {copied ? <Check aria-hidden="true" width={14} height={14} className="text-[var(--green)]" /> : <Copy aria-hidden="true" width={14} height={14} />}
            {copied ? "Copied" : "Copy quote"}
          </button>
        </div>
        {at === null && (
          <p role="alert" className="mt-4 rounded border border-[var(--red)] p-3 text-sm text-[var(--red)]">
            The cited quote was not found verbatim in this passage. Treat the citation as unverified.
          </p>
        )}
        {/* PDF hard line breaks collapse like any whitespace: the passage reads as prose */}
        <p className="mt-5 leading-relaxed">
          {at === null ? (
            passage.body
          ) : (
            <>
              {passage.body.slice(0, at[0])}
              <mark className="rounded bg-[var(--highlight)] px-0.5 text-[var(--ink)]">{passage.body.slice(at[0], at[1])}</mark>
              {passage.body.slice(at[1])}
            </>
          )}
        </p>
      </aside>
    </>
  );
}
