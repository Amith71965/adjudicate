import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { disposeItem, setReviewer, signOff } from "@/app/actions";
import { EvidenceMatrix } from "@/components/review/evidence-matrix";
import { ExportPanel } from "@/components/review/export-panel";
import { History } from "@/components/review/history";
import { ObjectionCard } from "@/components/review/objection-card";
import { PassageDrawer } from "@/components/review/passage-drawer";
import { RiskBars } from "@/components/review/risk-bars";
import type { Case } from "@/lib/review/cases";
import { itemAnchor, pct } from "@/lib/review/format";
import { getCase, REVIEWER_COOKIE, reviewStore } from "@/lib/review/server";
import { reviewState } from "@/lib/review/state";

type Search = Record<string, string | string[] | undefined>;

export default function CasePage({ params, searchParams }: PageProps<"/cases/[id]">) {
  return (
    <Suspense fallback={<p className="p-10 text-sm text-[var(--muted)]">Loading the case…</p>}>
      <CaseView params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Drawer({ c, search }: { c: Case; search: Search }) {
  const { item: itemId, cite } = search;
  if (typeof itemId !== "string" || typeof cite !== "string") return null;
  const item = c.items.find((i) => i.id === itemId);
  const citation = item?.kind === "prong" ? item.citations[Number(cite)] : undefined;
  if (!item || !citation) return null;
  const passage = await reviewStore().passage(citation.chunk_id);
  return <PassageDrawer passage={passage} quote={citation.quote} closeHref={`/cases/${c.id}#${itemAnchor(item.id)}`} />;
}

async function CaseView({ params, searchParams }: Pick<PageProps<"/cases/[id]">, "params" | "searchParams">) {
  const { id } = await params;
  const c = getCase(id);
  if (!c) notFound();
  const [events, search, jar] = await Promise.all([reviewStore().events(c.id), searchParams, cookies()]);
  const state = reviewState(c.items, events);
  const reviewer = jar.get(REVIEWER_COOKIE)?.value;
  const dispose = disposeItem.bind(null, c.id);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8">
      <Link href="/" className="font-mono text-xs text-[var(--muted)] underline underline-offset-4">All cases</Link>
      <header className="mt-4 flex flex-wrap items-end justify-between gap-6 border-b border-[var(--line)] pb-6">
        <div>
          <p className="font-mono text-[11px] tracking-[0.2em] text-[var(--accent)] uppercase">{c.id} · EB-1A · synthetic</p>
          <h1 className="mt-2 font-serif text-4xl">{c.beneficiary}</h1>
          <p className="mt-1 text-[var(--muted)]">{c.field}</p>
        </div>
        <dl className="flex gap-8 font-mono text-sm">
          <div><dt className="text-[11px] text-[var(--muted)] uppercase">RFE risk</dt><dd className="font-serif text-3xl">{pct(c.rfe_risk)}%</dd></div>
          <div><dt className="text-[11px] text-[var(--muted)] uppercase">Open</dt><dd className="font-serif text-3xl" data-testid="open-count">{state.open}</dd></div>
          <div><dt className="text-[11px] text-[var(--muted)] uppercase">Items</dt><dd className="font-serif text-3xl">{c.items.length}</dd></div>
        </dl>
      </header>

      <form action={setReviewer} className="mt-6 flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          <span className="font-mono text-xs text-[var(--muted)]">Reviewing as</span>
          <input name="reviewer" defaultValue={reviewer} required maxLength={80} className="mt-1 block w-64 rounded border border-[var(--line)] bg-[var(--card)] p-2" />
        </label>
        <button className="rounded border border-[var(--line)] px-3 py-2">{reviewer ? "Change" : "Start reviewing"}</button>
        {!reviewer && <p className="text-[var(--amber)]">Name yourself before resolving or dismissing items; every action is logged under that name.</p>}
      </form>

      {!c.complete && (
        <p className="mt-6 rounded border border-[var(--amber)] p-3 text-sm text-[var(--amber)]">
          The examiner could not ground every prong in this run. Items marked “Not reviewed” need your own review.
        </p>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_22rem]">
        <section aria-label="Objections" className="space-y-4">
          <h2 className="font-serif text-2xl">Objections and findings</h2>
          {c.items.map((item) => (
            <ObjectionCard key={item.id} caseId={c.id} item={item} state={state.items[item.id]} dispose={dispose} />
          ))}
        </section>
        <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <ExportPanel caseId={c.id} state={state} signoff={signOff.bind(null, c.id)} reviewer={reviewer} />
          <section aria-label="Risk by criterion" className="rounded-lg border border-[var(--line)] bg-[var(--card)] p-5">
            <h2 className="mb-4 font-serif text-xl">Risk by criterion</h2>
            <RiskBars risks={c.criterion_risk} />
            <p className="mt-4 text-xs text-[var(--muted)]">
              Prong risks are treated as independent, a simplification. Run: {c.run.model} ({c.run.cache_version}).
            </p>
          </section>
        </aside>
      </div>

      <section aria-label="Evidence" className="mt-12">
        <h2 className="mb-4 font-serif text-2xl">Evidence matrix</h2>
        <EvidenceMatrix artifacts={c.artifacts} items={c.items} />
      </section>

      <section aria-label="Version history" className="mt-12 mb-16">
        <h2 className="mb-4 font-serif text-2xl">Version history</h2>
        {state.orphans.length > 0 && (
          <p className="mb-3 text-sm text-[var(--amber)]">
            {state.orphans.length} logged item(s) are not in this run of the examiner: {state.orphans.join(", ")}.
          </p>
        )}
        <History events={state.history} />
      </section>

      <Drawer c={c} search={search} />
    </main>
  );
}
