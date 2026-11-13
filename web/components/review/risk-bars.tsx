"use client";
/** Per-criterion RFE risk, riskiest first. Click a bar to filter the objections to that criterion. */
import { Info } from "lucide-react";
import { useState } from "react";
import { label, pct } from "@/lib/review/format";

export const FILTER_EVENT = "adjudicate:filter-criterion";

export function RiskBars({ risks }: { risks: Record<string, number> }) {
  const [explain, setExplain] = useState(false);
  const rows = Object.entries(risks).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const pick = (criterion: string) => {
    window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail: criterion }));
    document.querySelector('[aria-label="Objections"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div>
      <div className="space-y-1">
        {rows.map(([criterion, risk]) => (
          <button key={criterion} type="button" onClick={() => pick(criterion)} aria-label={`Show ${label(criterion)} objections`} className="grid w-full grid-cols-[9rem_1fr_3rem] items-center gap-3 rounded-lg px-1 py-1 text-left text-sm hover:bg-[var(--paper)]">
            <span className="truncate">{label(criterion)}</span>
            <span role="meter" aria-label={`${label(criterion)} risk ${pct(risk)}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(risk)} className="h-2 overflow-hidden rounded bg-[var(--line)]">
              <span className="block h-full rounded" style={{ width: `${pct(risk)}%`, background: risk >= 0.7 ? "var(--red)" : risk >= 0.4 ? "var(--amber)" : "var(--green)" }} />
            </span>
            <span className="text-right font-mono text-xs">{pct(risk)}%</span>
          </button>
        ))}
      </div>
      <button type="button" aria-expanded={explain} onClick={() => setExplain((e) => !e)} className="mt-3 inline-flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)]">
        <Info aria-hidden="true" width={13} height={13} />How is this computed?
      </button>
      {explain && (
        <p className="pop-in mt-2 text-xs leading-relaxed text-[var(--muted)]">
          Each prong gets a risk from the examiner; a criterion fails if any of its prongs fails. The petition&apos;s RFE risk is the chance that fewer than three criteria survive, since EB-1A needs at least three. Prong risks are treated as independent, a simplification.
        </p>
      )}
    </div>
  );
}
