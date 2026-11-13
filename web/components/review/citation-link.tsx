"use client";
/**
 * A citation link that previews its AAO passage on hover or keyboard focus: the decision and its
 * date, the section, and the quoted words marked in their surrounding sentence. Clicking opens the
 * full passage drawer without reloading the page. A preview that cannot load says so.
 */
import Link from "next/link";
import { useId, useRef, useState } from "react";
import type { Citation } from "@/lib/review/cases";
import { citeHref, decisionDate, label } from "@/lib/review/format";
import { locateQuote } from "@/lib/review/store";

interface Preview { decision_id: string; section_kind: string; criterion: string | null; body: string }

const cache = new Map<number, Promise<Preview | null>>(); // passages never change: fetch each once
function load(chunkId: number): Promise<Preview | null> {
  let p = cache.get(chunkId);
  if (!p) {
    p = fetch(`/api/passages/${chunkId}`).then((r) => (r.ok ? (r.json() as Promise<Preview>) : null)).catch(() => null);
    cache.set(chunkId, p);
  }
  return p;
}

const CONTEXT = 150; // characters of surrounding text on each side of the quote

function Excerpt({ body, quote }: { body: string; quote: string }) {
  const at = locateQuote(body, quote);
  const cls = "mt-2 block text-[13px] leading-relaxed text-[var(--muted)]";
  if (!at) return <span className={`${cls} line-clamp-4`}>{body}</span>;
  const [s, e] = at;
  const from = Math.max(0, s - CONTEXT);
  const to = Math.min(body.length, e + CONTEXT);
  return (
    <span className={cls}>
      {from > 0 && "…"}
      {body.slice(from, s)}
      <mark className="rounded bg-[var(--highlight)] px-0.5 text-[var(--ink)]">{body.slice(s, e)}</mark>
      {body.slice(e, to)}
      {to < body.length && "…"}
    </span>
  );
}

export function CitationLink({ caseId, itemId, n, citation }: { caseId: string; itemId: string; n: number; citation: Citation }) {
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setOpen(true);
      load(citation.chunk_id).then(setPreview);
    }, 160);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span className="relative inline-block">
      <Link
        href={citeHref(caseId, itemId, n)}
        scroll={false}
        data-source=""
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="rounded font-mono text-xs text-[var(--accent)] underline underline-offset-2"
      >
        {citation.decision_id} · passage {citation.chunk_id}
      </Link>
      {open && (
        <span
          id={tipId}
          role="tooltip"
          className="pop-in absolute top-full left-0 z-40 mt-2 block w-[min(28rem,80vw)] rounded-xl border border-[var(--line)] bg-[var(--raised)] p-3.5 text-left shadow-[var(--shadow-2)]"
        >
          <span className="block font-mono text-[11px] tracking-wide text-[var(--muted)]">
            {citation.decision_id} · {decisionDate(citation.decision_id) || "AAO"}
          </span>
          {preview === undefined && <span className="mt-2 block h-12 animate-pulse rounded bg-[var(--line)]" />}
          {preview === null && <span className="mt-2 block text-[13px] text-[var(--muted)]">Preview unavailable. Open the passage to read it.</span>}
          {preview && (
            <>
              <span className="mt-1 block text-xs text-[var(--ink)]">
                {label(preview.section_kind)}{preview.criterion ? ` · ${label(preview.criterion)}` : ""}
              </span>
              <Excerpt body={preview.body} quote={citation.quote} />
            </>
          )}
        </span>
      )}
    </span>
  );
}
