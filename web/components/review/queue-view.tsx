"use client";
/** The review queue: search, sort and filter 16 cases, with progress and risk at a glance. */
import { CircleCheck, CircleDashed, PenLine, Search, Send } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, ViewTransition } from "react";
import { pct } from "@/lib/review/format";

export type QueueStatus = "open" | "awaiting" | "ready" | "exported";
export interface QueueRow { id: string; beneficiary: string; field: string; rfe_risk: number; total: number; decided: number; status: QueueStatus }

const STATUS: Record<QueueStatus, { label: string; icon: typeof CircleDashed; tone: string }> = {
  open: { label: "In review", icon: CircleDashed, tone: "text-[var(--muted)]" },
  awaiting: { label: "Awaiting sign-off", icon: PenLine, tone: "text-[var(--amber)]" },
  ready: { label: "Ready to export", icon: CircleCheck, tone: "text-[var(--green)]" },
  exported: { label: "Exported", icon: Send, tone: "text-[var(--accent)]" },
};
const riskColor = (r: number) => (r >= 0.7 ? "var(--red)" : r >= 0.4 ? "var(--amber)" : "var(--green)");
type Sort = "id" | "risk" | "open";

function Progress({ row }: { row: QueueRow }) {
  return (
    <div role="progressbar" aria-label={`${row.id} review progress`} aria-valuemin={0} aria-valuemax={row.total} aria-valuenow={row.decided} className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--line)]">
      <div className="h-full rounded-full bg-[var(--green)]" style={{ width: `${(row.decided / row.total) * 100}%` }} />
    </div>
  );
}
function Risk({ row }: { row: QueueRow }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-sm">
      <span role="meter" aria-label={`${row.id} RFE risk ${pct(row.rfe_risk)}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(row.rfe_risk)} className="h-2.5 w-2.5 rounded-full" style={{ background: riskColor(row.rfe_risk) }} />
      {pct(row.rfe_risk)}%
    </span>
  );
}
function Status({ s }: { s: QueueStatus }) {
  const { label, icon: Icon, tone } = STATUS[s];
  return <span className={`inline-flex items-center gap-1.5 text-sm ${tone}`}><Icon aria-hidden="true" width={15} height={15} />{label}</span>;
}

export function QueueView({ rows }: { rows: QueueRow[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("id");
  const [only, setOnly] = useState<QueueStatus | null>(null);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = rows.filter((r) => (!only || r.status === only) && words.every((w) => `${r.id} ${r.beneficiary} ${r.field}`.toLowerCase().includes(w)));
    const by: Record<Sort, (a: QueueRow, b: QueueRow) => number> = {
      id: (a, b) => a.id.localeCompare(b.id),
      risk: (a, b) => b.rfe_risk - a.rfe_risk || a.id.localeCompare(b.id),
      open: (a, b) => b.total - b.decided - (a.total - a.decided) || a.id.localeCompare(b.id),
    };
    return [...list].sort(by[sort]);
  }, [rows, q, sort, only]);
  const chip = (on: boolean) => `shrink-0 rounded-full border px-3 py-1 text-xs ${on ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)]"}`;
  const empty = <p className="py-10 text-center text-sm text-[var(--muted)]">No case matches “{q}”.</p>;

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative flex min-w-56 flex-1 items-center">
          <Search aria-hidden="true" width={15} height={15} className="absolute left-3 text-[var(--muted)]" />
          <input type="search" aria-label="Search cases" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by case, beneficiary or field" className="w-full rounded-lg border border-[var(--line)] bg-[var(--card)] py-2 pr-3 pl-9 text-sm" />
        </label>
        <label className="flex items-center gap-2 text-xs text-[var(--muted)]">Sort
          <select aria-label="Sort cases" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-lg border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-sm text-[var(--ink)]">
            <option value="id">Case</option><option value="risk">RFE risk</option><option value="open">Most open</option>
          </select>
        </label>
      </div>
      <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Status filter">
        <button type="button" aria-pressed={only === null} onClick={() => setOnly(null)} className={chip(only === null)}>All {rows.length}</button>
        {(Object.keys(STATUS) as QueueStatus[]).map((s) => (
          <button key={s} type="button" aria-pressed={only === s} onClick={() => setOnly(only === s ? null : s)} className={chip(only === s)}>
            {STATUS[s].label.replace(" to export", "")} {rows.filter((r) => r.status === s).length}
          </button>
        ))}
      </div>

      <table className="mt-4 hidden w-full border-collapse text-left text-sm md:table">
        <thead className="font-mono text-[11px] tracking-wider text-[var(--muted)] uppercase">
          <tr className="border-b border-[var(--line)]"><th className="py-2 pr-3">Case</th><th className="py-2 pr-3">Field</th><th className="py-2 pr-3">Progress</th><th className="py-2 pr-3">RFE risk</th><th className="py-2">Status</th></tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className="border-b border-[var(--line)] transition-colors hover:bg-[var(--card)]">
              <td className="py-3 pr-3">
                <Link href={`/cases/${r.id}`} transitionTypes={["nav-forward"]} className="font-mono underline underline-offset-4">{r.id}</Link>
                <ViewTransition name={`case-${r.id}`} share="morph" default="none"><span className="ml-3 inline-block">{r.beneficiary}</span></ViewTransition>
              </td>
              <td className="py-3 pr-3 text-[var(--muted)]">{r.field}</td>
              <td className="py-3 pr-3"><span className="flex items-center gap-2"><Progress row={r} /><span className="font-mono text-xs text-[var(--muted)]">{r.decided}/{r.total}</span></span></td>
              <td className="py-3 pr-3"><Risk row={r} /></td>
              <td className="py-3"><Status s={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <div className="hidden md:block">{empty}</div>}

      <ul className="mt-4 space-y-3 md:hidden" aria-label="Cases">
        {shown.map((r) => (
          <li key={r.id}>
            <Link href={`/cases/${r.id}`} transitionTypes={["nav-forward"]} className="block rounded-xl border border-[var(--line)] bg-[var(--card)] p-4">
              <span className="flex items-baseline justify-between gap-3"><span className="font-mono text-xs text-[var(--accent)]">{r.id}</span><Status s={r.status} /></span>
              <span className="mt-1 block font-serif text-lg">{r.beneficiary}</span>
              <span className="block text-xs text-[var(--muted)]">{r.field}</span>
              <span className="mt-3 flex items-center justify-between gap-3"><span className="flex items-center gap-2"><Progress row={r} /><span className="font-mono text-xs text-[var(--muted)]">{r.decided}/{r.total}</span></span><Risk row={r} /></span>
            </Link>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <div className="md:hidden">{empty}</div>}
    </div>
  );
}
