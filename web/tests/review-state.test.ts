/**
 * Phase 8 review state: folding the append-only review log over a case's items. Export is
 * allowed only when every item is resolved or dismissed with a note AND the attorney signed
 * off after the last change — enforced here, on the server, not just by a disabled button.
 */
import { describe, expect, it } from "vitest";
import { reviewState, type ReviewEvent } from "@/lib/review/state";

const ITEMS = [{ id: "prong:judging/whole" }, { id: "waiver:unclaimed_supported:high_salary" }];
let seq = 0;
const ev = (action: ReviewEvent["action"], item_id: string | null = null): ReviewEvent => ({
  id: ++seq, case_id: "P01", item_id, action, note: `note ${seq}`, actor: "Attorney A", created_at: `2026-11-12T10:00:${String(seq).padStart(2, "0")}Z`,
});
const [J, W] = ITEMS.map((i) => i.id);

describe("reviewState", () => {
  it("starts with everything open and export blocked", () => {
    const s = reviewState(ITEMS, []);
    expect(s.open).toBe(2);
    expect(s.gate).toEqual({ ready: false, reasons: ["2 objections still open", "attorney sign-off required"] });
  });

  it("takes the latest disposition of each item, so a reopen reopens", () => {
    const s = reviewState(ITEMS, [ev("resolve", J), ev("dismiss", W), ev("reopen", J)]);
    expect(s.items[J].status).toBe("open");
    expect(s.items[W]).toMatchObject({ status: "dismissed", actor: "Attorney A" });
    expect(s.open).toBe(1);
  });

  it("allows export once all are disposed and the attorney signs off afterwards", () => {
    const s = reviewState(ITEMS, [ev("resolve", J), ev("dismiss", W), ev("signoff")]);
    expect(s.gate).toEqual({ ready: true, reasons: [] });
  });

  it("voids a sign-off that predates a later change", () => {
    const s = reviewState(ITEMS, [ev("resolve", J), ev("dismiss", W), ev("signoff"), ev("reopen", J), ev("resolve", J)]);
    expect(s.gate).toEqual({ ready: false, reasons: ["sign-off predates the latest change: sign off again"] });
  });

  it("does not count a sign-off given while objections were open", () => {
    const s = reviewState(ITEMS, [ev("signoff"), ev("resolve", J), ev("dismiss", W)]);
    expect(s.gate.ready).toBe(false);
  });

  it("surfaces log entries for items this case no longer has instead of dropping them", () => {
    const s = reviewState(ITEMS, [ev("resolve", "prong:awards/whole")]);
    expect(s.orphans).toEqual(["prong:awards/whole"]);
  });

  it("lets a later entry for an item no longer in the case void the sign-off too", () => {
    const s = reviewState(ITEMS, [ev("resolve", J), ev("dismiss", W), ev("signoff"), ev("resolve", "prong:awards/whole")]);
    expect(s.gate.ready).toBe(false);
  });

  it("still requires a sign-off for a case with nothing to dispose of", () => {
    expect(reviewState([], []).gate).toEqual({ ready: false, reasons: ["attorney sign-off required"] });
  });

  it("keeps the whole log, oldest first, as the version history", () => {
    const log = [ev("resolve", J), ev("export")];
    expect(reviewState(ITEMS, [...log].reverse()).history.map((e) => e.id)).toEqual(log.map((e) => e.id));
  });
});
