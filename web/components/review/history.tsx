/** The append-only review log as a timeline: grouped by day (newest day first), oldest first within a day. */
import { CircleCheck, CircleMinus, Download, PenLine, RotateCcw } from "lucide-react";
import { decisionDate, itemTitle } from "@/lib/review/format";
import type { ReviewEvent } from "@/lib/review/state";

const VERB: Record<ReviewEvent["action"], string> = { resolve: "resolved", dismiss: "dismissed", reopen: "reopened", signoff: "signed off", export: "exported the memo" };
const ICON = { resolve: CircleCheck, dismiss: CircleMinus, reopen: RotateCcw, signoff: PenLine, export: Download } as const;
const TONE = { resolve: "text-[var(--green)]", dismiss: "text-[var(--muted)]", reopen: "text-[var(--amber)]", signoff: "text-[var(--accent)]", export: "text-[var(--accent)]" } as const;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function dayLabel(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return decisionDate(`${MONTHS[Number(m) - 1]}${d}${y}_00X0000`) || iso.slice(0, 10);
}

export function History({ events }: { events: ReviewEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-[var(--muted)]">No review actions yet.</p>;
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const days = [...new Set(sorted.map((e) => e.created_at.slice(0, 10)))].reverse();
  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day}>
          <h3 className="mb-2 font-mono text-[11px] tracking-wider text-[var(--muted)] uppercase">{dayLabel(day)}</h3>
          <ol className="relative space-y-3 border-l border-[var(--line)] pl-5">
            {sorted.filter((e) => e.created_at.slice(0, 10) === day).map((e) => {
              const Icon = ICON[e.action];
              return (
                <li key={e.id} className="relative text-sm">
                  <span className={`absolute top-0.5 -left-[1.95rem] flex h-5 w-5 items-center justify-center rounded-full bg-[var(--paper)] ${TONE[e.action]}`}>
                    <Icon aria-hidden="true" width={15} height={15} />
                  </span>
                  <time dateTime={e.created_at} className="mr-2 font-mono text-xs text-[var(--muted)]">{e.created_at.slice(11, 16)} UTC</time>
                  <b className="font-medium">{e.actor}</b> {VERB[e.action]}
                  {e.item_id ? ` ${itemTitle(e.item_id)}` : ""}: <span className="text-[var(--muted)]">{e.note}</span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
