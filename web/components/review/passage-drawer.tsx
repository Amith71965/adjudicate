import { label } from "@/lib/review/format";
import { locateQuote, type Passage } from "@/lib/review/store";

/** The AAO passage a citation points to, in full, with the quoted words marked. */
export function PassageDrawer({ passage, quote, closeHref }: { passage: Passage; quote: string; closeHref: string }) {
  const at = locateQuote(passage.body, quote);
  return (
    <aside
      id="passage"
      role="dialog"
      aria-label="AAO passage"
      className="fixed inset-y-0 right-0 z-20 flex w-full max-w-xl flex-col overflow-y-auto border-l border-[var(--line)] bg-[var(--paper)] p-6 shadow-2xl"
    >
      <div className="flex items-baseline justify-between gap-4">
        <p className="font-mono text-[11px] tracking-widest text-[var(--muted)] uppercase">AAO passage {passage.chunk_id}</p>
        <a href={closeHref} className="font-mono text-sm underline">Close</a>
      </div>
      <h2 className="mt-2 font-serif text-2xl">
        <a href={passage.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
          {passage.decision_id}
        </a>
      </h2>
      <p className="mt-1 font-mono text-xs text-[var(--muted)]">
        {label(passage.section_kind)}{passage.criterion ? ` · ${label(passage.criterion)}` : ""} · opens the USCIS PDF
      </p>
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
  );
}
