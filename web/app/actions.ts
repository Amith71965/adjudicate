"use server";
/**
 * Review Server Actions. Reachable by direct POST, so each one reloads the case's state from
 * the review log and re-checks its input (lib/review/actions-core) before appending. A refused
 * input or a stale tab comes back as { error } beside the form; an outage still throws.
 */
import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { disposition, ReviewInputError, signoffEvent } from "@/lib/review/actions-core";
import { getCase, REVIEWER_COOKIE, reviewStore } from "@/lib/review/server";
import { ReviewConflictError } from "@/lib/review/store";
import type { ActionResult } from "@/components/review/action-form";
import { reviewState } from "@/lib/review/state";

async function load(caseId: string) {
  const c = getCase(caseId);
  if (!c) throw new ReviewInputError(`no case ${caseId}`);
  const store = reviewStore();
  return { c, store, state: reviewState(c.items, await store.events(c.id)) };
}

async function refusedOr(work: () => Promise<void>): Promise<ActionResult> {
  try {
    await work();
  } catch (err) {
    if (err instanceof ReviewInputError) return { error: err.message };
    if (err instanceof ReviewConflictError) {
      refresh(); // show what changed
      return { error: "This case changed in another tab or request. It has been reloaded: check it, then try again." };
    }
    throw err;
  }
  refresh();
}

export async function disposeItem(caseId: string, form: FormData): Promise<ActionResult> {
  return refusedOr(async () => {
    const { c, store, state } = await load(caseId);
    const reviewer = (await cookies()).get(REVIEWER_COOKIE)?.value;
    await store.append(c.id, disposition(form, state, reviewer));
  });
}

export async function signOff(caseId: string, form: FormData): Promise<ActionResult> {
  return refusedOr(async () => {
    const { c, store, state } = await load(caseId);
    await store.append(c.id, signoffEvent(form, state));
  });
}

export async function setReviewer(form: FormData): Promise<void> {
  const name = String(form.get("reviewer") ?? "").trim();
  if (!name || name.length > 80) throw new ReviewInputError("a reviewer name of 1 to 80 characters is required");
  (await cookies()).set(REVIEWER_COOKIE, name, { httpOnly: true, sameSite: "lax", path: "/" });
  refresh();
}
