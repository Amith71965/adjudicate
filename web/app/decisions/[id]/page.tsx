/**
 * In-app AAO decision viewer: the stored PDF, opened on the page that holds a cited quote with
 * the words highlighted. Reached from the citation drawer's "Open in decision".
 */
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PdfViewer } from "@/components/review/pdf-viewer";
import { PageTransition } from "@/components/ui/page-transition";
import { decisionDate } from "@/lib/review/format";
import { reviewStore } from "@/lib/review/server";
import { DECISION_ID } from "@/lib/review/store";

export const metadata: Metadata = { title: "AAO decision" };

const SAFE_BACK = /^\/cases\/P\d{2,4}(\?[^#\s]*)?$/; // only back into this app's case pages

export default function DecisionPage({ params, searchParams }: PageProps<"/decisions/[id]">) {
  return (
    <PageTransition>
      <Suspense fallback={<p className="p-10 text-sm text-[var(--muted)]">Opening the decision…</p>}>
        <Viewer params={params} searchParams={searchParams} />
      </Suspense>
    </PageTransition>
  );
}

async function Viewer({ params, searchParams }: Pick<PageProps<"/decisions/[id]">, "params" | "searchParams">) {
  const { id } = await params;
  if (!DECISION_ID.test(id)) notFound();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  const quote = one(sp.q).slice(0, 2000);
  const back = SAFE_BACK.test(one(sp.back)) ? one(sp.back) : "/";
  const chunk = Number(one(sp.chunk));
  const store = reviewStore();
  const [located, passage] = await Promise.all([
    quote ? store.locate(id, quote).catch(() => null) : null,
    Number.isSafeInteger(chunk) && chunk > 0 ? store.passage(chunk).catch(() => null) : null,
  ]);
  const usc = passage && /^https:\/\//.test(passage.url) ? passage.url : null;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pt-6 pb-16 sm:px-8">
      <Link href={back} transitionTypes={["nav-back"]} className="inline-flex items-center gap-1 font-mono text-xs text-[var(--muted)] underline underline-offset-4">
        <ArrowLeft aria-hidden="true" width={13} height={13} />Back to the citation
      </Link>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] tracking-[0.2em] text-[var(--accent)] uppercase">AAO non-precedent decision</p>
          <h1 className="mt-1 font-serif text-4xl">{id}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {decisionDate(id)}
            {located?.page ? ` · quote on page ${located.page} of ${located.pages}` : quote ? " · the quote could not be placed on a page; showing page 1" : ""}
          </p>
        </div>
        {usc && (
          <a href={usc} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-3 py-1.5 text-sm hover:bg-[var(--card)]">
            <ExternalLink aria-hidden="true" width={14} height={14} />Source of record on uscis.gov
          </a>
        )}
      </header>
      {quote && (
        <blockquote className="measure mt-5 rounded-lg border-l-4 border-[var(--highlight)] bg-[var(--card)] px-4 py-3 text-sm text-[var(--muted)] italic">“{quote}”</blockquote>
      )}
      <div className="mt-4">
        <PdfViewer src={`/api/decisions/${id}/pdf`} quote={quote} quotePage={located?.page ?? null} />
      </div>
    </main>
  );
}
