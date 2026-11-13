// @vitest-environment jsdom
/**
 * U1 review workflow: progress at a glance, a compact decide-then-note action, optimistic
 * feedback that rolls back when the server refuses, filters and keyboard navigation.
 * The server rules (gate, stale-tab refusal, input checks) are unchanged and tested elsewhere.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionResult } from "@/components/review/action-form";
import { CaseReview } from "@/components/review/case-review";
import type { ProngItem, ReviewItem } from "@/lib/review/cases";
import type { ItemState } from "@/lib/review/state";

afterEach(cleanup);

const prong = (criterion: string, prongId = "whole"): ProngItem => ({
  kind: "prong", id: `prong:${criterion}/${prongId}`, criterion, prong: prongId, test: "t", artifact_ids: ["A01"],
  facially_met: true, risk: 0.5, rank: 0.5, objection: `Objection on ${criterion}.`,
  citations: [{ chunk_id: 1, decision_id: "JAN012026_01B2203", quote: "Petitioners must show that they actually participated." }],
});
const WAIVER: ReviewItem = { kind: "waiver", id: "waiver:unclaimed_supported:high_salary", criterion: "high_salary", finding: "unclaimed_supported", artifact_ids: ["A02"], rank: -1, message: "Evidence supports high_salary." };
const ITEMS: ReviewItem[] = [prong("judging"), prong("awards"), WAIVER];
const OPEN: Record<string, ItemState> = Object.fromEntries(ITEMS.map((i) => [i.id, { status: "open" }]));

function deferred() {
  let resolve!: (v: ActionResult) => void;
  const promise = new Promise<ActionResult>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(over: Partial<Parameters<typeof CaseReview>[0]> = {}) {
  const calls: Record<string, string>[] = [];
  const pending = deferred();
  const dispose = async (fd: FormData) => {
    calls.push(Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])));
    return pending.promise;
  };
  render(<CaseReview caseId="P01" items={ITEMS} states={OPEN} dispose={dispose} canAct {...over} />);
  return { calls, pending };
}
const card = (id: string) => document.querySelector(`[data-item-id="${id}"]`) as HTMLElement;

describe("progress", () => {
  it("shows how many items are decided", () => {
    setup({ states: { ...OPEN, [WAIVER.id]: { status: "dismissed", note: "n", actor: "A" } } });
    const bar = screen.getByRole("progressbar", { name: /review progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("3");
    expect(screen.getByText(/1 of 3 decided/i)).toBeTruthy();
  });
});

describe("deciding an item", () => {
  it("asks for a note only after you choose resolve or dismiss", async () => {
    setup();
    const c = within(card("prong:judging/whole"));
    expect(c.queryByLabelText(/attorney note/i)).toBeNull();
    await userEvent.click(c.getByRole("button", { name: "Resolve" }));
    const note = c.getByLabelText(/attorney note/i) as HTMLTextAreaElement;
    expect(note.required).toBe(true);
    expect(document.activeElement).toBe(note);
    await userEvent.click(c.getByRole("button", { name: "Cancel" }));
    expect(c.queryByLabelText(/attorney note/i)).toBeNull();
  });

  it("shows the decision at once, before the server answers", async () => {
    const { calls, pending } = setup();
    const c = within(card("prong:judging/whole"));
    await userEvent.click(c.getByRole("button", { name: "Resolve" }));
    await userEvent.type(c.getByLabelText(/attorney note/i), "Reports are in Exhibit 14.");
    await userEvent.click(c.getByRole("button", { name: /confirm resolve/i }));
    expect(card("prong:judging/whole").dataset.status).toBe("resolved");
    expect(screen.getByText(/1 of 3 decided/i)).toBeTruthy();
    expect(calls).toEqual([{ item_id: "prong:judging/whole", action: "resolve", note: "Reports are in Exhibit 14." }]);
    await act(async () => pending.resolve(undefined));
    expect(await screen.findByRole("status")).toBeTruthy(); // a quiet confirmation toast
  });

  it("rolls back and keeps the note when the server refuses", async () => {
    const { pending } = setup();
    const c = within(card("prong:judging/whole"));
    await userEvent.click(c.getByRole("button", { name: "Dismiss" }));
    await userEvent.type(c.getByLabelText(/attorney note/i), "Already covered.");
    await userEvent.click(c.getByRole("button", { name: /confirm dismiss/i }));
    await act(async () => pending.resolve({ error: "This case changed in another tab or request." }));
    expect(card("prong:judging/whole").dataset.status).toBe("open");
    expect((within(card("prong:judging/whole")).getByLabelText(/attorney note/i) as HTMLTextAreaElement).value).toBe("Already covered.");
    expect(screen.getAllByRole("alert").some((a) => /changed in another tab/.test(a.textContent ?? ""))).toBe(true);
  });

  it("folds a decided item to a summary with who decided and why, and can reopen it", async () => {
    setup({ states: { ...OPEN, [WAIVER.id]: { status: "dismissed", note: "Not claimed on purpose.", actor: "Attorney A" } } });
    const c = within(card(WAIVER.id));
    expect(c.getByText(/dismissed by attorney a/i)).toBeTruthy();
    expect(c.getByText("Not claimed on purpose.")).toBeTruthy();
    expect(c.queryByRole("button", { name: "Resolve" })).toBeNull();
    await userEvent.click(c.getByRole("button", { name: "Reopen" }));
    expect(c.getByLabelText(/attorney note/i)).toBeTruthy();
  });

  it("explains why it cannot act until a reviewer is named", () => {
    setup({ canAct: false });
    const resolve = within(card("prong:judging/whole")).getByRole("button", { name: "Resolve" }) as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);
    expect(screen.getByText(/name yourself/i)).toBeTruthy();
  });
});

describe("finding your way", () => {
  it("filters to open items", async () => {
    setup({ states: { ...OPEN, [WAIVER.id]: { status: "dismissed", note: "n", actor: "A" } } });
    await userEvent.click(screen.getByRole("button", { name: /^open/i }));
    expect(card(WAIVER.id)).toBeNull();
    expect(card("prong:judging/whole")).toBeTruthy();
  });

  it("filters by criterion", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /^awards/i }));
    expect(card("prong:judging/whole")).toBeNull();
    expect(card("prong:awards/whole")).toBeTruthy();
  });

  it("jumps to the next open item", async () => {
    setup({ states: { ...OPEN, ["prong:judging/whole"]: { status: "resolved", note: "n", actor: "A" } } });
    await userEvent.click(screen.getByRole("button", { name: /next open/i }));
    expect(document.activeElement).toBe(card("prong:awards/whole"));
  });

  it("moves with j and k, decides with r, and shows the shortcuts with ?", async () => {
    setup();
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(card("prong:judging/whole"));
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(card("prong:awards/whole"));
    await userEvent.keyboard("k");
    expect(document.activeElement).toBe(card("prong:judging/whole"));
    await userEvent.keyboard("r");
    const note = within(card("prong:judging/whole")).getByLabelText(/attorney note/i);
    expect(document.activeElement).toBe(note);
    await userEvent.keyboard("jk"); // typing in the note is not navigation
    expect((note as HTMLTextAreaElement).value).toBe("jk");
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("?");
    expect(screen.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeTruthy();
  });
});
