import { ATTESTATION } from "@/lib/review/actions-core";
import type { ReviewState } from "@/lib/review/state";

type Action = (form: FormData) => Promise<void>;

/** Sign-off and export. The server re-checks the same gate on export (409 otherwise). */
export function ExportPanel({ caseId, state, signoff }: { caseId: string; state: ReviewState; signoff: Action }) {
  const { gate } = state;
  return (
    <section aria-label="Sign-off and export" className="rounded-lg border border-[var(--line)] bg-[var(--card)] p-5">
      <h2 className="font-serif text-xl">Sign-off and export</h2>
      {state.signoff && (
        <p className="mt-2 text-sm text-[var(--muted)]">
          Signed off by {state.signoff.actor} · {state.signoff.created_at.slice(0, 16).replace("T", " ")}
        </p>
      )}
      {gate.ready ? (
        <a
          href={`/api/cases/${caseId}/export`}
          download
          className="mt-4 inline-block rounded bg-[var(--ink)] px-4 py-2 text-sm text-[var(--paper)]"
        >
          Export review memo
        </a>
      ) : (
        <ul className="mt-3 space-y-1 text-sm text-[var(--red)]">
          {gate.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <form action={signoff} className="mt-5 space-y-3 border-t border-[var(--line)] pt-4">
        <label className="block text-sm">
          <span className="font-mono text-xs text-[var(--muted)]">Your full name</span>
          <input name="actor" required maxLength={80} autoComplete="name" className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--paper)] p-2" />
        </label>
        <label className="flex gap-2 text-sm leading-snug">
          <input type="checkbox" name="attest" required className="mt-1" />
          <span>{ATTESTATION}</span>
        </label>
        <button
          disabled={state.open > 0}
          className="rounded border border-[var(--ink)] px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          Sign off
        </button>
        {state.open > 0 && <p className="text-xs text-[var(--muted)]">Resolve or dismiss every item before signing off.</p>}
      </form>
    </section>
  );
}
