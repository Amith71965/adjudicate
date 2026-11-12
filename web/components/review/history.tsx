import { itemTitle } from "@/lib/review/format";
import type { ReviewEvent } from "@/lib/review/state";

const VERB: Record<ReviewEvent["action"], string> = {
  resolve: "resolved",
  dismiss: "dismissed",
  reopen: "reopened",
  signoff: "signed off",
  export: "exported the memo",
};

/** The append-only review log, oldest first: the case's version history. */
export function History({ events }: { events: ReviewEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-[var(--muted)]">No review actions yet.</p>;
  return (
    <ol className="space-y-2 text-sm">
      {[...events].sort((a, b) => a.id - b.id).map((e) => (
        <li key={e.id} className="grid grid-cols-[8.5rem_1fr] gap-3">
          <time dateTime={e.created_at} className="font-mono text-xs text-[var(--muted)]">
            {e.created_at.slice(0, 16).replace("T", " ")}
          </time>
          <span>
            <b className="font-medium">{e.actor}</b> {VERB[e.action]}
            {e.item_id ? ` ${itemTitle(e.item_id)}` : ""}: <span className="text-[var(--muted)]">{e.note}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
