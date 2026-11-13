/**
 * Exhibits × criteria. A filled dot means the petition claims the exhibit for that criterion; a
 * link means an AI finding on that criterion names the exhibit (one click to the finding).
 */
import type { Case, ReviewItem } from "@/lib/review/cases";
import { itemAnchor, itemTitle, label } from "@/lib/review/format";

export function EvidenceMatrix({ artifacts, items }: { artifacts: Case["artifacts"]; items: ReviewItem[] }) {
  const criteria = [...new Set([...artifacts.flatMap((a) => (a.claimed_criterion ? [a.claimed_criterion] : [])), ...items.map((i) => i.criterion)])];
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--line)]">
      <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
        <thead className="bg-[var(--card)] font-mono text-[11px] tracking-wider text-[var(--muted)]">
          <tr className="border-b border-[var(--line)]">
            <th className="px-3 py-2 uppercase">Exhibit</th>
            <th className="px-3 py-2 uppercase">Claimed for</th>
            {criteria.map((c) => <th key={c} className="px-2 py-2 text-center normal-case">{label(c)}</th>)}
          </tr>
        </thead>
        <tbody>
          {artifacts.map((a) => (
            <tr key={a.id} id={`artifact-${a.id}`} className="scroll-mt-24 border-b border-[var(--line)] align-top transition-colors last:border-0 hover:bg-[var(--card)] target:bg-[var(--highlight)]">
              <td className="px-3 py-3">
                <span className="font-mono text-xs text-[var(--accent)]">{a.id}</span> <span className="font-mono text-xs text-[var(--muted)]">{a.kind}</span>
                <p className="mt-1">{a.title}</p>
                <p className="measure mt-1 text-xs text-[var(--muted)]">{a.description}</p>
              </td>
              <td className="px-3 py-3">{a.claimed_criterion ? label(a.claimed_criterion) : <span className="text-[var(--amber)]">not claimed</span>}</td>
              {criteria.map((c) => {
                const named = items.filter((i) => i.criterion === c && i.artifact_ids.includes(a.id));
                return (
                  <td key={c} className="px-2 py-3 text-center">
                    {a.claimed_criterion === c && <span role="img" aria-label={`claimed for ${label(c)}`} className="mx-auto mb-1 block h-2.5 w-2.5 rounded-full bg-[var(--ink)]" />}
                    {named.map((i) => (
                      <a key={i.id} href={`#${itemAnchor(i.id)}`} aria-label={itemTitle(i)} title={itemTitle(i)} className="group mx-auto grid h-6 w-6 place-items-center rounded">
                        <span aria-hidden="true" className="block h-3 w-3 rounded-sm border-2 border-[var(--seal)] group-hover:bg-[var(--seal)]" />
                      </a>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-[var(--line)] px-3 py-2 text-xs text-[var(--muted)]">
        <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--ink)]" /> claimed ·{" "}
        <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm border-2 border-[var(--seal)] align-middle" /> named by an AI finding (click to open it)
      </p>
    </div>
  );
}
