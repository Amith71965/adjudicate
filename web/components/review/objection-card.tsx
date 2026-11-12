import type { ReviewItem } from "@/lib/review/cases";
import { citeHref, itemAnchor, itemTitle, label, pct } from "@/lib/review/format";
import type { ItemState } from "@/lib/review/state";

type Action = (form: FormData) => Promise<void>;

const KIND = {
  prong: { tag: "AI objection", tone: "text-[var(--red)]" },
  waiver: { tag: "Waiver check", tone: "text-[var(--amber)]" },
  manual: { tag: "Not reviewed", tone: "text-[var(--amber)]" },
} as const;

function EvidenceLinks({ ids, source }: { ids: string[]; source: boolean }) {
  return (
    <p className="mt-3 font-mono text-xs text-[var(--muted)]">
      Evidence:{" "}
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ", "}
          <a href={`#artifact-${id}`} data-source={source ? "" : undefined} className="underline decoration-dotted underline-offset-2 hover:text-[var(--ink)]">
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
        <p className="mt-1 text-sm text-[var(--muted)]">Tests whether {item.test}.</p>
        <p className="mt-3 leading-relaxed">{item.objection}</p>
        <ul className="mt-3 space-y-2">
          {item.citations.map((c, n) => (
            <li key={c.chunk_id} className="border-l-2 border-[var(--line)] pl-3 text-sm">
              <a href={citeHref(caseId, item.id, n)} data-source="" className="font-mono text-xs text-[var(--red)] underline underline-offset-2">
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
        <p className="mt-3 leading-relaxed">{item.message}</p>
        <EvidenceLinks ids={item.artifact_ids} source />
      </>
    );
  }
  return (
    <>
      <p className="mt-1 text-sm text-[var(--muted)]">Tests whether {item.test}.</p>
      <p className="mt-3 leading-relaxed">
        The examiner could not ground a review of this prong in AAO reasoning ({label(item.reason)}), so it shows no
        objection. Review the evidence for this prong yourself.
      </p>
      <EvidenceLinks ids={item.artifact_ids} source />
    </>
  );
}

export function ObjectionCard({ caseId, item, state, dispose }: { caseId: string; item: ReviewItem; state: ItemState; dispose: Action }) {
  const kind = KIND[item.kind];
  const noteId = `note-${itemAnchor(item.id)}`;
  const done = state.status !== "open";
  return (
    <article
      id={itemAnchor(item.id)}
      data-testid="objection"
      data-item-id={item.id}
      data-status={state.status}
      className={`scroll-mt-6 rounded-lg border border-[var(--line)] bg-[var(--card)] p-5 ${done ? "opacity-75" : ""}`}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`font-mono text-[11px] tracking-widest uppercase ${kind.tone}`}>{kind.tag}</span>
        <h3 className="font-serif text-xl">{itemTitle(item)}</h3>
        {item.kind === "prong" && (
          <span className="ml-auto font-mono text-xs text-[var(--muted)]">
            risk {pct(item.risk)}%{item.facially_met ? "" : " · not facially met"}
          </span>
        )}
      </header>
      <Body caseId={caseId} item={item} />
      <form action={dispose} className="mt-4 border-t border-[var(--line)] pt-4">
        <input type="hidden" name="item_id" value={item.id} />
        {done && (
          <div className="mb-3 text-sm">
            <p className={state.status === "resolved" ? "text-[var(--green)]" : "text-[var(--muted)]"}>
              {state.status === "resolved" ? "Resolved" : "Dismissed"} by {state.actor}
            </p>
            <p className="mt-1">{state.note}</p>
          </div>
        )}
        <label htmlFor={noteId} className="block font-mono text-xs text-[var(--muted)]">
          {done ? "Attorney note (why reopen)" : "Attorney note"}
        </label>
        <textarea
          id={noteId}
          name="note"
          required
          minLength={3}
          maxLength={2000}
          rows={2}
          className="mt-1 w-full rounded border border-[var(--line)] bg-[var(--paper)] p-2 text-sm"
        />
        <div className="mt-2 flex gap-2">
          {done ? (
            <button name="action" value="reopen" className="rounded border border-[var(--line)] px-3 py-1 text-sm">Reopen</button>
          ) : (
            <>
              <button name="action" value="resolve" className="rounded bg-[var(--ink)] px-3 py-1 text-sm text-[var(--paper)]">Resolve</button>
              <button name="action" value="dismiss" className="rounded border border-[var(--line)] px-3 py-1 text-sm">Dismiss</button>
            </>
          )}
        </div>
      </form>
    </article>
  );
}
