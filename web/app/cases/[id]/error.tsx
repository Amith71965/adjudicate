"use client";
// A refused action or a review log that is down lands here, never as a silently empty case.

export default function CaseError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined;
  return (
    <main role="alert" className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-8">
      <h1 className="font-serif text-3xl">This case could not be shown or updated</h1>
      <p className="mt-3 text-[var(--muted)]">
        Either the action was refused (every disposition needs a named reviewer and a note; sign-off needs every item
        disposed) or the review log is unavailable (start it with <code className="font-mono">make api</code>).
        Nothing was recorded unless it appears in the version history.
      </p>
      {digest && <p className="mt-2 font-mono text-xs text-[var(--muted)]">error {digest}</p>}
      <button onClick={() => retry()} className="mt-6 rounded border border-[var(--ink)] px-4 py-2 text-sm">Try again</button>
    </main>
  );
}
