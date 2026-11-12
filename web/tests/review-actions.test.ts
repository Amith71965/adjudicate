/**
 * Server-action input checks (Phase 8). Server Actions are reachable by direct POST, so every
 * check the form makes is made again here: a named reviewer, an item this case really has,
 * a transition that fits its current status, a real note; sign-off only when nothing is open.
 */
import { describe, expect, it } from "vitest";
import { disposition, signoffEvent } from "@/lib/review/actions-core";
import { reviewState, type ReviewEvent } from "@/lib/review/state";

const ITEMS = [{ id: "prong:judging/whole" }];
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const OPEN = reviewState(ITEMS, []);
const resolved: ReviewEvent = { id: 1, case_id: "P01", item_id: "prong:judging/whole", action: "resolve", note: "Added reports.", actor: "A", created_at: "t" };
const DONE = reviewState(ITEMS, [resolved]);

describe("disposition", () => {
  const ok = { item_id: "prong:judging/whole", action: "resolve", note: "  Added the review reports.  " };

  it("builds the event from the form and the reviewer", () => {
    expect(disposition(form(ok), OPEN, "Attorney A")).toEqual({ item_id: "prong:judging/whole", action: "resolve", note: "Added the review reports.", actor: "Attorney A" });
  });

  it.each([
    [{ ...ok }, OPEN, undefined, /reviewer/],
    [{ ...ok, item_id: "prong:awards/whole" }, OPEN, "A", /not an item/],
    [{ ...ok, action: "signoff" }, OPEN, "A", /action/],
    [{ ...ok, note: " x " }, OPEN, "A", /note/],
    [{ ...ok }, DONE, "A", /already resolved/],
    [{ ...ok, action: "reopen" }, OPEN, "A", /already open/],
  ])("refuses %j", (fields, state, reviewer, error) => {
    expect(() => disposition(form(fields as Record<string, string>), state, reviewer)).toThrow(error);
  });

  it("lets a disposed item be reopened", () => {
    expect(disposition(form({ ...ok, action: "reopen", note: "Reports missing." }), DONE, "A").action).toBe("reopen");
  });
});

describe("signoffEvent", () => {
  it("records the attestation under the attorney's typed name", () => {
    const e = signoffEvent(form({ actor: " Attorney A ", attest: "on" }), DONE);
    expect(e).toMatchObject({ item_id: null, action: "signoff", actor: "Attorney A" });
    expect(e.note).toMatch(/take responsibility/);
  });

  it.each([
    [{ actor: "Attorney A" }, DONE, /attest/],
    [{ actor: " ", attest: "on" }, DONE, /name/],
    [{ actor: "Attorney A", attest: "on" }, OPEN, /every item/],
  ])("refuses %j", (fields, state, error) => {
    expect(() => signoffEvent(form(fields), state)).toThrow(error);
  });
});
