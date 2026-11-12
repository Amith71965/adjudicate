import { label, pct } from "@/lib/review/format";

/** Per-criterion RFE risk, riskiest first. Prong risks are treated as independent. */
export function RiskBars({ risks }: { risks: Record<string, number> }) {
  const rows = Object.entries(risks).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  return (
    <div className="space-y-2">
      {rows.map(([criterion, risk]) => (
        <div key={criterion} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3 text-sm">
          <span className="truncate">{label(criterion)}</span>
          <div
            role="meter"
            aria-label={`${label(criterion)} risk ${pct(risk)}%`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct(risk)}
            className="h-2 overflow-hidden rounded bg-[var(--line)]"
          >
            <div className="h-full rounded" style={{ width: `${pct(risk)}%`, background: risk >= 0.7 ? "var(--red)" : risk >= 0.4 ? "var(--amber)" : "var(--green)" }} />
          </div>
          <span className="text-right font-mono text-xs">{pct(risk)}%</span>
        </div>
      ))}
    </div>
  );
}
