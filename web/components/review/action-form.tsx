"use client";
/**
 * A form for a review Server Action. A refused action (stale tab, missing reviewer, bad note)
 * comes back as { error } and is shown next to the form, with the typed note put back: losing
 * an attorney's note to a full error page is how notes stop being written. Infrastructure
 * failures still throw to the error boundary.
 */
import { useActionState, useEffect, useRef, type ReactNode } from "react";

export type ActionResult = { error?: string; note?: string } | void;
export type ReviewAction = (form: FormData) => Promise<ActionResult>;

export function ActionForm({ action, className, children }: { action: ReviewAction; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLFormElement>(null);
  const [result, run, pending] = useActionState(async (_prev: ActionResult, form: FormData) => {
    const out = await action(form);
    return out?.error ? { ...out, note: String(form.get("note") ?? "") } : out;
  }, undefined);

  useEffect(() => {
    // React resets the form after an action; put the attorney's note back when it was refused
    const note = ref.current?.elements.namedItem("note");
    if (result?.error && result.note && note instanceof HTMLTextAreaElement) note.value = result.note;
  }, [result]);

  return (
    <form ref={ref} action={run} className={className} aria-busy={pending}>
      {children}
      {result?.error && (
        <p role="alert" className="mt-2 text-sm text-[var(--red)]">
          {result.error}
        </p>
      )}
    </form>
  );
}
