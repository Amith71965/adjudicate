/**
 * Review state (Phase 8): the append-only review log folded over a case's items. The export
 * gate lives here and is checked on the server: every item resolved or dismissed with a note,
 * and an attorney sign-off given after the last change.
 */

export type ReviewAction = "resolve" | "dismiss" | "reopen" | "signoff" | "export";

/** One row of the review_event log, as the FastAPI service returns it. */
export interface ReviewEvent {
  id: number;
  case_id: string;
  item_id: string | null;
  action: ReviewAction;
  note: string;
  actor: string;
  created_at: string;
}

export type ItemStatus = "open" | "resolved" | "dismissed";
export interface ItemState {
  status: ItemStatus;
  note?: string;
  actor?: string;
  at?: string;
}

export interface ReviewState {
  items: Record<string, ItemState>;
  open: number;
  signoff: ReviewEvent | null; // the latest sign-off, valid or not
  gate: { ready: boolean; reasons: string[] };
  orphans: string[]; // log entries for items this case no longer has
  history: ReviewEvent[]; // oldest first: the version history
}

const DISPOSITIONS = new Set<ReviewAction>(["resolve", "dismiss", "reopen"]);
const STATUS: Record<string, ItemStatus> = { resolve: "resolved", dismiss: "dismissed", reopen: "open" };

export function reviewState(items: { id: string }[], events: ReviewEvent[]): ReviewState {
  const history = [...events].sort((a, b) => a.id - b.id);
  const state: Record<string, ItemState> = Object.fromEntries(items.map((i) => [i.id, { status: "open" }]));
  const orphans = new Set<string>();
  let lastChange = 0;
  let signoff: ReviewEvent | null = null;

  for (const e of history) {
    if (e.action === "signoff") signoff = e;
    if (!DISPOSITIONS.has(e.action) || e.item_id === null) continue;
    lastChange = e.id;
    if (!(e.item_id in state)) {
      orphans.add(e.item_id);
      continue;
    }
    state[e.item_id] = e.action === "reopen"
      ? { status: "open" }
      : { status: STATUS[e.action], note: e.note, actor: e.actor, at: e.created_at };
  }

  const open = Object.values(state).filter((s) => s.status === "open").length;
  const reasons: string[] = [];
  if (open > 0) reasons.push(`${open} objection${open === 1 ? "" : "s"} still open`);
  if (signoff === null) reasons.push("attorney sign-off required");
  else if (signoff.id < lastChange && open === 0) reasons.push("sign-off predates the latest change: sign off again");
  else if (signoff.id < lastChange) reasons.push("attorney sign-off required");

  return { items: state, open, signoff, gate: { ready: reasons.length === 0, reasons }, orphans: [...orphans], history };
}
