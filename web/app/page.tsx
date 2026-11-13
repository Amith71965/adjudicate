import type { Metadata } from "next";
import { Suspense } from "react";
import { QueueView, type QueueRow } from "@/components/review/queue-view";
import { PageTransition, Reveal, SkeletonExit } from "@/components/ui/page-transition";
import { QueueSkeleton } from "@/components/ui/skeleton";
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
  const rows: QueueRow[] = cases.map((c, i) => {
    const state = reviewState(c.items, logs[i]);
    const s = status(logs[i], state.gate.ready, state.open);
    return {
      id: c.id, beneficiary: c.beneficiary, field: c.field, rfe_risk: c.rfe_risk, total: c.items.length,
      decided: c.items.length - state.open,
      status: s === "Exported" ? "exported" : s === "Ready to export" ? "ready" : s === "Awaiting sign-off" ? "awaiting" : "open",
    };
  });
  return <QueueView rows={rows} />;
}
