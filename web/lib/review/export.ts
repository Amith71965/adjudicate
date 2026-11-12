/**
 * The export gate and the review memo (Phase 8). The gate is checked here, on the server, from
 * the review log: the UI's disabled button is a convenience, not the protection.
 */
import type { Case, ReviewItem } from "./cases";
import { reviewState, type ReviewEvent } from "./state";
import { ReviewStoreError, type ReviewStore } from "./store";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function heading(item: ReviewItem): string {
  if (item.kind === "waiver") return `${item.criterion}: ${item.finding.replace(/_/g, " ")} (waiver check)`;
  return `${item.criterion} / ${item.prong}${item.kind === "manual" ? " (not reviewed by the examiner)" : ""}`;
}

export function buildMemo(c: Case, events: ReviewEvent[]): string {
  const state = reviewState(c.items, events);
  const signoff = state.signoff;
  const lines = [
    `# Adjudicate pre-filing review: ${c.id}`,
    "",
    `Field: ${c.field}. Synthetic petition; not legal advice.`,
    `Examiner run: ${c.run.model} (${c.run.cache_version}), RFE risk ${c.rfe_risk.toFixed(2)}${c.complete ? "" : ", incomplete run"}.`,
    signoff ? `Signed off by ${signoff.actor} at ${signoff.created_at}: ${signoff.note}` : "Not signed off.",
    "",
  ];
  for (const item of c.items) {
    const s = state.items[item.id];
    const verb = s.status === "open" ? "Open" : `${s.status[0].toUpperCase()}${s.status.slice(1)} by ${s.actor}`;
    lines.push(`## ${heading(item)}`, "");
    if (item.kind === "prong") {
      lines.push(`AI objection (risk ${item.risk.toFixed(2)}): ${item.objection}`, "");
      for (const cite of item.citations) lines.push(`- ${cite.decision_id}, passage ${cite.chunk_id}: "${cite.quote}"`);
      lines.push("");
    } else if (item.kind === "waiver") {
      lines.push(`AI finding: ${item.message}`, "");
    } else {
      lines.push(`The examiner could not ground a review of this prong (${item.reason}); reviewed manually.`, "");
    }
    lines.push(`Evidence: ${item.artifact_ids.join(", ")}`, `**${verb}.**${s.note ? ` ${s.note}` : ""}`, "");
  }
  return lines.join("\n");
}

export function makeExportHandler({ getCase, store }: { getCase: (id: string) => Case | undefined; store: ReviewStore }) {
  return async (caseId: string): Promise<Response> => {
    const c = getCase(caseId);
    if (!c) return json({ error: `no case ${caseId}` }, 404);
    let events: ReviewEvent[];
    try {
      events = await store.events(c.id);
    } catch (err) {
      if (err instanceof ReviewStoreError) return json({ error: `review log unavailable: ${err.message}` }, 503);
      throw err;
    }
    const state = reviewState(c.items, events);
    if (!state.gate.ready) return json({ error: "export blocked", reasons: state.gate.reasons }, 409);
    const memo = buildMemo(c, events);
    try {
      await store.append(c.id, { item_id: null, action: "export", note: "Exported the review memo.", actor: state.signoff!.actor });
    } catch (err) {
      if (err instanceof ReviewStoreError) return json({ error: `could not log the export: ${err.message}` }, 503);
      throw err;
    }
    return new Response(memo, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="adjudicate-${c.id}-review.md"`,
      },
    });
  };
}
