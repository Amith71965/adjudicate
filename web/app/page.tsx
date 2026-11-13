import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, ViewTransition } from "react";
import { PageTransition, Reveal, SkeletonExit } from "@/components/ui/page-transition";
import { QueueSkeleton } from "@/components/ui/skeleton";
import { pct } from "@/lib/review/format";
import { allCases, reviewStore } from "@/lib/review/server";
import { reviewState, type ReviewEvent } from "@/lib/review/state";

export const metadata: Metadata = { title: "Review queue" };

export default function Home() {
  return (
    <PageTransition>
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-8">
      <p className="font-mono text-[11px] tracking-[0.2em] text-[var(--accent)] uppercase">Review queue</p>
      <h1 className="mt-3 font-serif text-5xl">Cases</h1>
      <p className="mt-3 max-w-2xl text-[var(--muted)]">
        Sixteen synthetic EB-1A petitions, each with a recorded run of the adversarial examiner. Every AI objection
        must be resolved or dismissed with a note, and the case signed off, before its review memo can be exported.
      </p>
      <Suspense fallback={<SkeletonExit><QueueSkeleton /></SkeletonExit>}>
        <Reveal><CaseTable /></Reveal>
      </Suspense>
      <p className="mt-10 text-xs text-[var(--muted)]">Synthetic petitions and applicants only. Not legal advice.</p>
    </main>
    </PageTransition>
  );
}

function status(events: ReviewEvent[], ready: boolean, open: number): string {
  const last = events.at(-1);
  if (ready && last?.action === "export") return "Exported";
  if (ready) return "Ready to export";
  return open === 0 ? "Awaiting sign-off" : `${open} open`;
}

async function CaseTable() {
  const cases = allCases();
  const store = reviewStore();
  let logs: ReviewEvent[][];
  try {
    logs = await Promise.all(cases.map((c) => store.events(c.id)));
  } catch (err) {
    return (
      <p role="alert" className="mt-10 rounded border border-[var(--red)] p-4 text-sm text-[var(--red)]">
        The review log is unavailable ({err instanceof Error ? err.message : String(err)}). Start it with{" "}
        <code className="font-mono">make api</code>.
      </p>
    );
  }
  return (
    <div className="mt-8 overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <thead className="font-mono text-[11px] tracking-wider text-[var(--muted)] uppercase">
          <tr className="border-b border-[var(--line)]">
            <th className="py-2 pr-3">Case</th>
            <th className="py-2 pr-3">Field</th>
            <th className="py-2 pr-3 text-right">RFE risk</th>
            <th className="py-2 pr-3 text-right">Items</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c, i) => {
            const state = reviewState(c.items, logs[i]);
            return (
              <tr key={c.id} className="border-b border-[var(--line)] hover:bg-[var(--card)]">
                <td className="py-3 pr-3">
                  <Link href={`/cases/${c.id}`} transitionTypes={["nav-forward"]} className="font-mono underline underline-offset-4">{c.id}</Link>
                  <ViewTransition name={`case-${c.id}`} share="morph" default="none"><span className="ml-3 inline-block">{c.beneficiary}</span></ViewTransition>
                </td>
                <td className="py-3 pr-3 text-[var(--muted)]">{c.field}</td>
                <td className="py-3 pr-3 text-right font-mono">{pct(c.rfe_risk)}%</td>
                <td className="py-3 pr-3 text-right font-mono">{c.items.length}</td>
                <td className="py-3">{status(logs[i], state.gate.ready, state.open)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
