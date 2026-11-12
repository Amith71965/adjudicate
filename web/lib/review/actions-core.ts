/**
 * Input checks behind the review Server Actions. Server Actions are reachable by direct POST,
 * so nothing the form enforces is trusted: each check is made again here, against the case's
 * current state from the review log.
 */
import type { ReviewState } from "./state";
import type { NewEvent } from "./store";

export const ATTESTATION =
  "I reviewed every AI objection, finding and source in this case, and I take responsibility for what is filed.";

export class ReviewInputError extends Error {}

/** The write is only valid against the log the user was looking at. */
const lastSeen = (state: ReviewState) => state.history.at(-1)?.id ?? 0;

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
};

export function disposition(form: FormData, state: ReviewState, reviewer: string | undefined): NewEvent {
  const actor = reviewer?.trim() ?? "";
  if (!actor || actor.length > 80) throw new ReviewInputError("name the reviewer before disposing of an item");
  const item_id = text(form, "item_id");
  const current = state.items[item_id];
  if (!current) throw new ReviewInputError(`${JSON.stringify(item_id)} is not an item of this case`);
  const action = text(form, "action");
  if (action !== "resolve" && action !== "dismiss" && action !== "reopen") {
    throw new ReviewInputError(`unknown action ${JSON.stringify(action)}`);
  }
  if (action === "reopen" && current.status === "open") throw new ReviewInputError(`${item_id} is already open`);
  if (action !== "reopen" && current.status !== "open") throw new ReviewInputError(`${item_id} is already ${current.status}`);
  const note = text(form, "note");
  if (note.length < 3 || note.length > 2000) throw new ReviewInputError("an attorney note of 3 to 2000 characters is required");
  return { item_id, action, note, actor, expected_last_id: lastSeen(state) };
}

export function signoffEvent(form: FormData, state: ReviewState): NewEvent {
  if (form.get("attest") !== "on") throw new ReviewInputError("sign-off requires the attestation");
  const actor = text(form, "actor");
  if (!actor || actor.length > 80) throw new ReviewInputError("sign-off requires your full name");
  if (state.open > 0) throw new ReviewInputError("resolve or dismiss every item before signing off");
  return { item_id: null, action: "signoff", note: ATTESTATION, actor, expected_last_id: lastSeen(state) };
}
