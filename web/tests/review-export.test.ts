/**
 * Export gate on the server: GET /api/cases/[id]/export returns the review memo only when
 * every objection is disposed with a note and the attorney signed off after the last change.
 * Otherwise 409 with the reasons — the button being disabled is not the protection.
 */
import { describe, expect, it } from "vitest";
import type { Case } from "@/lib/review/cases";
import { buildMemo, makeExportHandler } from "@/lib/review/export";
import type { ReviewEvent } from "@/lib/review/state";
import { ReviewConflictError, ReviewStoreError, type ReviewStore } from "@/lib/review/store";

const CASE: Case = {
  id: "P01", field: "marine robotics", beneficiary: "Dr. Example Person", rfe_risk: 0.5, complete: true,
  criterion_risk: { judging: 0.5 }, run: { model: "anthropic/claude-haiku-5.5", cache_version: "examiner-v3" },
  artifacts: [{ id: "A01", kind: "record", title: "Review invitations", description: "Editor emails.", claimed_criterion: "judging" }],
  items: [{
    kind: "prong", id: "prong:judging/whole", criterion: "judging", prong: "whole", test: "t", artifact_ids: ["A01"],
    facially_met: true, risk: 0.5, objection: "Invitations alone are not judging.", rank: 0.5,
    citations: [{ chunk_id: 7, decision_id: "JAN012026_01B2203", quote: "Petitioners must show that they actually participated in judging." }],
  }],
};

let seq = 0;
const ev = (action: ReviewEvent["action"], item_id: string | null = null, note = "Added the review reports."): ReviewEvent =>
  ({ id: ++seq, case_id: "P01", item_id, action, note, actor: "Attorney A", created_at: "2026-11-12T10:00:00Z" });

function store(events: ReviewEvent[], fail = false, conflict = false): ReviewStore & { appended: unknown[] } {
  const appended: unknown[] = [];
  return {
    appended,
    async events() {
      if (fail) throw new ReviewStoreError("http://api/cases/P01/events answered 503");
      return events;
    },
    async append(_caseId, e) {
      if (conflict) throw new ReviewConflictError("http://api/cases/P01/events answered 409");
      appended.push(e);
      return { ...ev(e.action, e.item_id, e.note), actor: e.actor };
    },
    async passage() {
      throw new Error("unused");
    },
  };
}
const handler = (s: ReviewStore) => makeExportHandler({ getCase: (id) => (id === "P01" ? CASE : undefined), store: s });

describe("export gate", () => {
  it("refuses export while an objection is open, with the reason", async () => {
    const s = store([]);
    const res = await handler(s)("P01");
    expect(res.status).toBe(409);
    expect((await res.json()).reasons).toEqual(["1 objection still open", "attorney sign-off required"]);
    expect(s.appended).toEqual([]);
  });

  it("refuses export without a sign-off after the last disposition", async () => {
    const res = await handler(store([ev("signoff"), ev("resolve", "prong:judging/whole")]))("P01");
    expect(res.status).toBe(409);
  });

  it("exports the memo once disposed and signed off, and logs the export", async () => {
    const events = [ev("resolve", "prong:judging/whole"), ev("signoff", null, "I reviewed every objection.")];
    const s = store(events);
    const res = await handler(s)("P01");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="adjudicate-P01-review\.md"/);
    expect(await res.text()).toMatch(/Added the review reports\./);
    expect(s.appended).toEqual([{ item_id: null, action: "export", note: "Exported the review memo.", actor: "Attorney A", expected_last_id: events[1].id }]);
  });

  it("logs a repeat download once, not on every request", async () => {
    const s = store([ev("resolve", "prong:judging/whole"), ev("signoff"), ev("export")]);
    expect((await handler(s)("P01")).status).toBe(200);
    expect(s.appended).toEqual([]);
  });

  it("refuses the export when the case changed between reading and logging it", async () => {
    const res = await handler(store([ev("resolve", "prong:judging/whole"), ev("signoff")], false, true))("P01");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed/);
  });

  it("is a 404 for an unknown case and a 503 when the log is down", async () => {
    expect((await handler(store([]))("P77")).status).toBe(404);
    expect((await handler(store([], true))("P01")).status).toBe(503);
  });
});

describe("buildMemo", () => {
  const events = [ev("dismiss", "prong:judging/whole", "Reports already in Exhibit 9."), ev("signoff", null, "I reviewed every objection.")];
  const memo = buildMemo(CASE, events);

  it("records every objection with the attorney's disposition and note", () => {
    expect(memo).toMatch(/judging \/ whole/);
    expect(memo).toMatch(/Dismissed by Attorney A/);
    expect(memo).toMatch(/Reports already in Exhibit 9\./);
  });

  it("keeps an attorney note on one line so it cannot forge memo structure", () => {
    const forged = buildMemo(CASE, [ev("dismiss", "prong:judging/whole", "fine\n## Fake heading\n**Resolved by Someone.**"), ev("signoff")]);
    expect(forged).not.toMatch(/^## Fake heading/m);
  });

  it("says the names are self-reported", () => {
    expect(memo).toMatch(/self-reported/i);
  });

  it("names its sources and its limits", () => {
    expect(memo).toMatch(/JAN012026_01B2203/);
    expect(memo).toMatch(/Signed off by Attorney A/);
    expect(memo).toMatch(/not legal advice/i);
    expect(memo).toMatch(/anthropic\/claude-haiku-5\.5/);
  });
});
