// @vitest-environment jsdom
/**
 * U4: a review queue you can search, sort and filter, with progress and risk at a glance; an
 * evidence matrix that is a real exhibits × criteria grid; a history you can scan; and risk bars
 * that filter the objections they summarise.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CaseReview } from "@/components/review/case-review";
import { EvidenceMatrix } from "@/components/review/evidence-matrix";
import { History } from "@/components/review/history";
import { QueueView, type QueueRow } from "@/components/review/queue-view";
import { RiskBars } from "@/components/review/risk-bars";
import type { Case, ProngItem, ReviewItem } from "@/lib/review/cases";
import type { ReviewEvent } from "@/lib/review/state";

afterEach(cleanup);

const ROWS: QueueRow[] = [
  { id: "P01", beneficiary: "Dr. Avery Quillfeather", field: "renewable energy engineering", rfe_risk: 0.52, total: 12, decided: 0, status: "open" },
  { id: "P05", beneficiary: "Indigo Brackenridge", field: "computational biology", rfe_risk: 0.92, total: 10, decided: 10, status: "ready" },
  { id: "P11", beneficiary: "Dr. Lark Fennimore", field: "jazz performance", rfe_risk: 0.65, total: 10, decided: 4, status: "open" },
];
const table = () => screen.getByRole("table");
const ids = () => within(table()).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent?.slice(0, 3));

describe("review queue", () => {
  it("shows each case's progress and risk", () => {
    render(<QueueView rows={ROWS} />);
    const bar = within(table()).getByRole("progressbar", { name: "P11 review progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("4");
    expect(bar.getAttribute("aria-valuemax")).toBe("10");
    expect(within(table()).getByRole("meter", { name: "P05 RFE risk 92%" })).toBeTruthy();
    expect(within(table()).getByText("Ready to export")).toBeTruthy();
  });

  it("searches by id, beneficiary or field", async () => {
    render(<QueueView rows={ROWS} />);
    await userEvent.type(screen.getByRole("searchbox", { name: /search cases/i }), "jazz");
    expect(ids()).toEqual(["P11"]);
  });

  it("sorts by risk and filters by status", async () => {
    render(<QueueView rows={ROWS} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /sort/i }), "risk");
    expect(ids()).toEqual(["P05", "P11", "P01"]);
    await userEvent.click(screen.getByRole("button", { name: /^ready/i }));
    expect(ids()).toEqual(["P05"]);
  });

  it("says when nothing matches", async () => {
    render(<QueueView rows={ROWS} />);
    await userEvent.type(screen.getByRole("searchbox", { name: /search cases/i }), "astronaut");
    expect(screen.getAllByText(/no case matches/i).length).toBeGreaterThan(0);
  });
});

const PRONG: ProngItem = {
  kind: "prong", id: "prong:judging/whole", criterion: "judging", prong: "whole", test: "t", artifact_ids: ["A02"],
  facially_met: true, risk: 0.35, rank: 0.35, objection: "o", citations: [{ chunk_id: 1, decision_id: "JAN012026_01B2203", quote: "q".repeat(40) }],
};
const WAIVER: ReviewItem = { kind: "waiver", id: "waiver:unclaimed_supported:high_salary", criterion: "high_salary", finding: "unclaimed_supported", artifact_ids: ["A01"], rank: -1, message: "m" };
const ARTIFACTS: Case["artifacts"] = [
  { id: "A01", kind: "contract", title: "Pay statement", description: "Salary survey." },
  { id: "A02", kind: "record", title: "Review invitations", description: "Editor emails.", claimed_criterion: "judging" },
];

describe("evidence matrix grid", () => {
  it("has a column per criterion and marks what each exhibit is claimed for and named by", () => {
    render(<EvidenceMatrix artifacts={ARTIFACTS} items={[PRONG, WAIVER]} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["judging", "high salary"]));
    const a02 = document.getElementById("artifact-A02")!;
    expect(within(a02).getByRole("img", { name: /claimed for judging/i })).toBeTruthy();
    expect(within(a02).getByRole("link", { name: /judging \/ whole/i }).getAttribute("href")).toBe("#item-prong-judging-whole");
    expect(within(document.getElementById("artifact-A01")!).getByRole("link", { name: /high salary waiver check/i })).toBeTruthy();
    // a 24 px target (WCAG 2.5.8) around the small mark
    for (const link of within(a02).getAllByRole("link")) expect(link.className).toMatch(/\bh-6\b.*\bw-6\b/);
  });
});

describe("history timeline", () => {
  const ev = (id: number, action: ReviewEvent["action"], item_id: string | null, at: string): ReviewEvent =>
    ({ id, case_id: "P01", item_id, action, note: "n", actor: "Attorney A", created_at: at });

  it("groups the log by day, newest day first, with an icon per action", () => {
    render(<History events={[ev(1, "resolve", PRONG.id, "2026-11-11T10:00:00Z"), ev(2, "signoff", null, "2026-11-12T09:00:00Z")]} />);
    const days = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(days).toEqual(["12 Nov 2026", "11 Nov 2026"]);
    expect(document.querySelectorAll("li svg").length).toBe(2);
  });
});

describe("risk bars that filter", () => {
  it("filters the objections to the criterion you click", async () => {
    render(
      <>
        <RiskBars risks={{ judging: 0.35, high_salary: 0.9 }} />
        <CaseReview caseId="P01" items={[PRONG, WAIVER]} states={{ [PRONG.id]: { status: "open" }, [WAIVER.id]: { status: "open" } }} dispose={async () => {}} canAct />
      </>,
    );
    // label in name (WCAG 2.5.3): the accessible name starts with what the button shows
    await userEvent.click(screen.getByRole("button", { name: /^judging 35%.*show these objections/i }));
    expect(document.querySelector(`[data-item-id="${WAIVER.id}"]`)).toBeNull();
    expect(document.querySelector(`[data-item-id="${PRONG.id}"]`)).toBeTruthy();
  });

  it("explains how risk is computed", async () => {
    render(<RiskBars risks={{ judging: 0.35 }} />);
    await userEvent.click(screen.getByRole("button", { name: /how is this computed/i }));
    expect(screen.getByText(/at least three/i)).toBeTruthy();
  });
});
