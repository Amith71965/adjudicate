"use client";
import { Eye, Lock, LockOpen } from "lucide-react";
import { useCallback, useState } from "react";
import { ATTESTATION } from "@/lib/review/actions-core";
import type { ReviewState } from "@/lib/review/state";
import { ActionForm, type ReviewAction } from "./action-form";
import { MemoPreview } from "./memo-preview";

/** Sign-off and export. The server re-checks the same gate on export (409 otherwise). */
export function ExportPanel({ caseId, state, signoff, reviewer, memo }: { caseId: string; state: ReviewState; signoff: ReviewAction; reviewer?: string; memo?: string }) {
  const { gate } = state;
  const [preview, setPreview] = useState(false);
  const close = useCallback(() => setPreview(false), []);
  const exportHref = `/api/cases/${caseId}/export`;
  return (
    <section aria-label="Sign-off and export" className="rounded-lg border border-[var(--line)] bg-[var(--card)] p-5">
      <h2 className="flex items-center gap-2 font-serif text-xl">
        {gate.ready ? <LockOpen aria-hidden="true" width={18} height={18} className="text-[var(--green)]" /> : <Lock aria-hidden="true" width={18} height={18} className="text-[var(--muted)]" />}
        Sign-off and export
      </h2>
      {state.signoff && (
        <p className="mt-2 text-sm text-[var(--muted)]">
          Signed off by {state.signoff.actor} · {state.signoff.created_at.slice(0, 16).replace("T", " ")}
        </p>
      )}
      {gate.ready ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={exportHref} download className="inline-block rounded-lg bg-[var(--ink)] px-4 py-2 text-sm text-[var(--paper)]">
            Export review memo
          </a>
          {memo && (
            <button type="button" onClick={() => setPreview(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-3 py-2 text-sm hover:bg-[var(--paper)]">
              <Eye aria-hidden="true" width={15} height={15} />Preview memo
            </button>
          )}
        </div>
      ) : (
        <ul className="mt-3 space-y-1 text-sm text-[var(--red)]">
          {gate.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <ActionForm action={signoff} className="mt-5 space-y-3 border-t border-[var(--line)] pt-4">
        <label className="block text-sm">
          <span className="font-mono text-xs text-[var(--muted)]">Your full name</span>
          <input name="actor" defaultValue={reviewer} required maxLength={80} autoComplete="name" className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--paper)] p-2" />
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
        <p className="text-xs text-[var(--muted)]">Names are self-reported: this prototype has no authentication.</p>
      </ActionForm>
      {preview && memo && <MemoPreview memo={memo} exportHref={exportHref} onClose={close} />}
    </section>
  );
}
