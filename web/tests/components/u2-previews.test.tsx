// @vitest-environment jsdom
/**
 * U2 previews: hovering a citation previews its AAO passage in context; the drawer moves between
 * an item's citations, copies the quote and opens the decision itself; an evidence link opens
 * the exhibit; the memo can be read (and printed) before it is exported.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseReview } from "@/components/review/case-review";
import { CitationLink } from "@/components/review/citation-link";
import { ExportPanel } from "@/components/review/export-panel";
import { PassageDrawer } from "@/components/review/passage-drawer";
import type { Case, ProngItem, ReviewItem } from "@/lib/review/cases";
import { reviewState, type ReviewEvent } from "@/lib/review/state";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const QUOTE = "Expert letters should specifically describe a petitioner's contribution and its significance";
const PASSAGE = {
  chunk_id: 10423, decision_id: "AUG172026_02B2203", url: "https://www.uscis.gov/x.pdf", section_kind: "criterion", criterion: "original_contributions",
  body: `The letters praise the work. ${QUOTE} to the field. The record does not show that.`, start_char: 0, end_char: 200,
};
const ITEM: ProngItem = {
  kind: "prong", id: "prong:original_contributions/original", criterion: "original_contributions", prong: "original", test: "t",
  artifact_ids: ["A07"], facially_met: false, risk: 0.6, rank: 0.8, objection: "Letters describe, not attribute.",
  citations: [
    { chunk_id: 13748, decision_id: "APR282026_01B2203", quote: "In order to satisfy the regulation a petitioner must establish originality." },
    { chunk_id: 10423, decision_id: "AUG172026_02B2203", quote: QUOTE },
  ],
};

describe("citation hover preview", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(PASSAGE), { status: 200 }));
  });

  it("previews the passage in context on hover, with the date and the quote marked", async () => {
    render(<CitationLink caseId="P01" itemId={ITEM.id} n={1} citation={ITEM.citations[1]} />);
    const link = screen.getByRole("link", { name: /AUG172026_02B2203/ });
    expect(link.getAttribute("href")).toBe("/cases/P01?item=prong%3Aoriginal_contributions%2Foriginal&cite=1#passage");
    await userEvent.hover(link);
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toMatch(/17 Aug 2026/);
    expect(tip.textContent).toMatch(/original contributions/);
    expect(within(tip).getByText(/Expert letters should/, { selector: "mark" })).toBeTruthy();
    expect(link.getAttribute("aria-describedby")).toBe(tip.id);
    await userEvent.unhover(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("previews on keyboard focus too", async () => {
    render(<CitationLink caseId="P01" itemId={ITEM.id} n={1} citation={ITEM.citations[1]} />);
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toBeTruthy();
  });

  it("says so when the preview cannot load, instead of showing nothing", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("{}", { status: 503 }));
    render(<CitationLink caseId="P01" itemId={ITEM.id} n={0} citation={ITEM.citations[0]} />);
    await userEvent.hover(screen.getByRole("link"));
    expect((await screen.findByRole("tooltip")).textContent).toMatch(/preview unavailable/i);
  });
});

describe("passage drawer navigation", () => {
  it("moves between an item's citations and opens the decision itself", () => {
    render(<PassageDrawer passage={PASSAGE} quote={QUOTE} closeHref="/cases/P01" caseId="P01" item={ITEM} n={1} />);
    const dialog = screen.getByRole("dialog", { name: /AAO passage/i });
    expect(dialog.textContent).toMatch(/citation 2 of 2/i);
    expect(within(dialog).getByRole("link", { name: /previous citation/i }).getAttribute("href")).toBe("/cases/P01?item=prong%3Aoriginal_contributions%2Foriginal&cite=0#passage");
    expect(within(dialog).queryByRole("link", { name: /next citation/i })).toBeNull();
    const open = within(dialog).getByRole("link", { name: /open in decision/i }).getAttribute("href")!;
    expect(open).toMatch(/^\/decisions\/AUG172026_02B2203\?/);
    expect(new URLSearchParams(open.split("?")[1]).get("q")).toBe(QUOTE);
  });

  it("copies the quote with its citation", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PassageDrawer passage={PASSAGE} quote={QUOTE} closeHref="/cases/P01" caseId="P01" item={ITEM} n={1} />);
    await userEvent.click(screen.getByRole("button", { name: /copy quote/i }));
    expect(writeText).toHaveBeenCalledWith(`“${QUOTE}” (AUG172026_02B2203, AAO, 17 Aug 2026)`);
    expect(await screen.findByText(/copied/i)).toBeTruthy();
  });
});

describe("exhibit preview", () => {
  const ARTIFACTS: Case["artifacts"] = [
    { id: "A02", kind: "contract", title: "Pay statement with survey data", description: "Pay above the 95th percentile.", claimed_criterion: null },
  ];
  const WAIVER: ReviewItem = { kind: "waiver", id: "waiver:unclaimed_supported:high_salary", criterion: "high_salary", finding: "unclaimed_supported", artifact_ids: ["A02"], rank: -1, message: "Evidence supports high_salary." };

  it("opens the exhibit from an evidence link, and Escape closes it", async () => {
    render(<CaseReview caseId="P01" items={[WAIVER]} states={{ [WAIVER.id]: { status: "open" } }} dispose={async () => {}} canAct artifacts={ARTIFACTS} />);
    await userEvent.click(screen.getByRole("link", { name: "A02" }));
    const dialog = screen.getByRole("dialog", { name: /exhibit A02/i });
    expect(dialog.textContent).toMatch(/Pay statement with survey data/);
    expect(dialog.textContent).toMatch(/not claimed/i);
    expect(dialog.textContent).toMatch(/high salary waiver check/i);
    expect(window.location.hash).toBe("#artifact-A02");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /exhibit/i })).toBeNull();
  });
});

describe("memo preview", () => {
  const PRONG = ITEM;
  const ev = (id: number, action: ReviewEvent["action"], item_id: string | null): ReviewEvent =>
    ({ id, case_id: "P01", item_id, action, note: "Letters now attribute the method.", actor: "Attorney A", created_at: "2026-11-12T10:00:00Z" });

  it("lets the attorney read the memo before exporting, and print it", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const state = reviewState([PRONG], [ev(1, "resolve", PRONG.id), ev(2, "signoff", null)]);
    const memo = "# Adjudicate pre-filing review: P01\n\n## original contributions / original\n\n**Resolved by Attorney A.** Letters now attribute the method.";
    render(<ExportPanel caseId="P01" state={state} signoff={async () => {}} memo={memo} />);
    await userEvent.click(screen.getByRole("button", { name: /preview memo/i }));
    const dialog = screen.getByRole("dialog", { name: /review memo/i });
    expect(within(dialog).getByRole("heading", { level: 1 }).textContent).toBe("Adjudicate pre-filing review: P01");
    expect(within(dialog).getByText("Resolved by Attorney A.").tagName).toBe("STRONG");
    await userEvent.click(within(dialog).getByRole("button", { name: /print/i }));
    expect(print).toHaveBeenCalled();
    await act(async () => { await userEvent.keyboard("{Escape}"); });
    expect(screen.queryByRole("dialog", { name: /review memo/i })).toBeNull();
  });

  it("offers no preview while export is blocked", () => {
    render(<ExportPanel caseId="P01" state={reviewState([PRONG], [])} signoff={async () => {}} />);
    expect(screen.queryByRole("button", { name: /preview memo/i })).toBeNull();
  });
});
