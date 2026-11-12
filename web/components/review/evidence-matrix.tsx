import type { Case, ReviewItem } from "@/lib/review/cases";
import { itemAnchor, itemTitle, label } from "@/lib/review/format";

/** Every exhibit, what it is claimed for, and which AI findings name it (each a link). */
export function EvidenceMatrix({ artifacts, items }: { artifacts: Case["artifacts"]; items: ReviewItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <thead className="font-mono text-[11px] tracking-wider text-[var(--muted)] uppercase">
          <tr className="border-b border-[var(--line)]">
            <th className="py-2 pr-3">Exhibit</th>
            <th className="py-2 pr-3">What it is</th>
            <th className="py-2 pr-3">Claimed for</th>
            <th className="py-2">Named by</th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((a) => {
            const named = items.filter((i) => i.artifact_ids.includes(a.id));
            return (
              <tr key={a.id} id={`artifact-${a.id}`} className="scroll-mt-6 border-b border-[var(--line)] align-top target:bg-[var(--highlight)]">
                <td className="py-3 pr-3 font-mono text-xs">{a.id}<br /><span className="text-[var(--muted)]">{a.kind}</span></td>
                <td className="py-3 pr-3">
                  <p>{a.title}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">{a.description}</p>
                </td>
                <td className="py-3 pr-3">{a.claimed_criterion ? label(a.claimed_criterion) : <span className="text-[var(--muted)]">not claimed</span>}</td>
                <td className="py-3">
                  {named.map((i) => (
                    <a key={i.id} href={`#${itemAnchor(i.id)}`} className="mr-2 block underline decoration-dotted underline-offset-2">
                      {itemTitle(i)}
                    </a>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
