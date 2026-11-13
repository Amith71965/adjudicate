// @vitest-environment jsdom
/**
 * Review UI components (Phase 8). The rule under test throughout: every AI claim on screen
 * links to its source in one click — an objection to the AAO passages it cites, a waiver
 * finding or unreviewed prong to the evidence rows it names.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Case, ProngItem, ReviewItem } from "@/lib/review/cases";
import { reviewState, type ReviewEvent } from "@/lib/review/state";
import { EvidenceMatrix } from "@/components/review/evidence-matrix";
import { ExportPanel } from "@/components/review/export-panel";
import { History } from "@/components/review/history";
import { ObjectionCard } from "@/components/review/objection-card";
import { PassageDrawer } from "@/components/review/passage-drawer";
import { RiskBars } from "@/components/review/risk-bars";

afterEach(cleanup);
const noop = async () => {};

const PRONG: ProngItem = {
  kind: "prong", id: "prong:judging/whole", criterion: "judging", prong: "whole", test: "the evidence satisfies the judging criterion",
  artifact_ids: ["A02"], facially_met: true, risk: 0.35, rank: 0.35, objection: "Invitations alone are not judging.",
  citations: [
    { chunk_id: 11941, decision_id: "NOV192025_01B2203", quote: "Examples of judging may include peer review for a scholarly journal." },
    { chunk_id: 13432, decision_id: "JAN212026_02B2203", quote: "Petitioners must show that they actually participated in judging." },
  ],
};
const WAIVER: ReviewItem = {
  kind: "waiver", id: "waiver:unclaimed_supported:high_salary", criterion: "high_salary", finding: "unclaimed_supported",
  artifact_ids: ["A01"], rank: -1, message: "Evidence supports high_salary but the petition does not claim it.",
};
const MANUAL: ReviewItem = {
  kind: "manual", id: "manual:leading_role/role", criterion: "leading_role", prong: "role", test: "a leading or critical role",
  artifact_ids: ["A03"], rank: 1, reason: "invalid_citations",
};
const ev = (id: number, action: ReviewEvent["action"], item_id: string | null, note = "Added the review reports."): ReviewEvent =>
  ({ id, case_id: "P01", item_id, action, note, actor: "Attorney A", created_at: `2026-11-12T10:00:0${id}Z` });

describe("ObjectionCard", () => {
  it("links each citation of an AI objection to its passage in one click", () => {
    render(<ObjectionCard caseId="P01" item={PRONG} state={{ status: "open" }} dispose={noop} />);
    const links = screen.getAllByRole("link", { name: /NOV192025_01B2203|JAN212026_02B2203/ });
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/cases/P01?item=prong%3Ajudging%2Fwhole&cite=0#passage",
      "/cases/P01?item=prong%3Ajudging%2Fwhole&cite=1#passage",
    ]);
    expect(screen.getByText("Invitations alone are not judging.")).toBeTruthy();
  });

  it.each([WAIVER, MANUAL])("links a %s finding to the evidence it names", (item) => {
    render(<ObjectionCard caseId="P01" item={item} state={{ status: "open" }} dispose={noop} />);
    const card = screen.getByTestId("objection");
    const sources = within(card).getAllByRole("link").filter((a) => a.hasAttribute("data-source"));
    expect(sources.map((a) => a.getAttribute("href"))).toEqual([`#artifact-${item.artifact_ids[0]}`]);
  });

  it("says plainly when the examiner could not review a prong", () => {
    render(<ObjectionCard caseId="P01" item={MANUAL} state={{ status: "open" }} dispose={noop} />);
    expect(screen.getByText(/could not ground/i)).toBeTruthy();
  });

  it("asks for a note once you choose to resolve or dismiss an open item", async () => {
    render(<ObjectionCard caseId="P01" item={PRONG} state={{ status: "open" }} dispose={noop} />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    const note = screen.getByLabelText(/attorney note/i) as HTMLTextAreaElement;
    expect(note.required).toBe(true);
    expect(note.minLength).toBe(3);
    expect(screen.getByRole("button", { name: /confirm resolve/i })).toBeTruthy();
  });

  it("shows who disposed an item and why, and offers to reopen it", () => {
    render(<ObjectionCard caseId="P01" item={PRONG} state={{ status: "dismissed", note: "Already in Exhibit 9.", actor: "Attorney A", at: "t" }} dispose={noop} />);
    expect(screen.getByTestId("objection").dataset.status).toBe("dismissed");
    expect(screen.getByText(/Dismissed by Attorney A/)).toBeTruthy();
    expect(screen.getByText(/Already in Exhibit 9\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });
});

describe("PassageDrawer", () => {
  const passage = {
    chunk_id: 13432, decision_id: "JAN212026_02B2203", url: "https://www.uscis.gov/x.pdf", section_kind: "criterion",
    criterion: "judging", body: "The record has invitations. Petitioners must show that they\nactually participated in judging. More.", start_char: 0, end_char: 99,
  };

  it("shows the full passage with the cited quote highlighted and a link to the decision", () => {
    render(<PassageDrawer passage={passage} quote="Petitioners must show that they actually participated in judging." closeHref="/cases/P01" />);
    const drawer = screen.getByRole("dialog", { name: /AAO passage/i });
    expect(within(drawer).getByText(/Petitioners must show/, { selector: "mark" })).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: /JAN212026_02B2203/ }).getAttribute("href")).toBe("https://www.uscis.gov/x.pdf");
  });

  it("warns instead of pretending when the quote is not in the passage", () => {
    render(<PassageDrawer passage={passage} quote="A sentence the decision never wrote at all." closeHref="/cases/P01" />);
    expect(screen.getByRole("alert").textContent).toMatch(/not found verbatim/i);
    expect(screen.queryByText(/./, { selector: "mark" })).toBeNull();
  });
});

describe("ExportPanel", () => {
  it("lists what blocks export and offers no download", () => {
    const state = reviewState([PRONG], []);
    render(<ExportPanel caseId="P01" state={state} signoff={noop} />);
    expect(screen.getByText("1 objection still open")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /export/i })).toBeNull();
    expect((screen.getByRole("button", { name: /sign off/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires the attorney's name and attestation to sign off", () => {
    const state = reviewState([PRONG], [ev(1, "resolve", PRONG.id)]);
    render(<ExportPanel caseId="P01" state={state} signoff={noop} />);
    expect((screen.getByLabelText(/your full name/i) as HTMLInputElement).required).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).required).toBe(true);
    expect((screen.getByRole("button", { name: /sign off/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers the export download once the gate is open", () => {
    const state = reviewState([PRONG], [ev(1, "resolve", PRONG.id), ev(2, "signoff", null, "I reviewed every objection.")]);
    render(<ExportPanel caseId="P01" state={state} signoff={noop} />);
    expect(screen.getByRole("link", { name: /export review memo/i }).getAttribute("href")).toBe("/api/cases/P01/export");
    expect(screen.getByText(/Signed off by Attorney A/)).toBeTruthy();
  });
});

describe("RiskBars", () => {
  it("lists criteria from riskiest to safest", () => {
    render(<RiskBars risks={{ judging: 0.35, leading_role: 0.956, awards: 0.6 }} />);
    expect(screen.getAllByRole("meter").map((m) => m.getAttribute("aria-label"))).toEqual([
      "leading role risk 96%", "awards risk 60%", "judging risk 35%",
    ]);
  });
});

describe("EvidenceMatrix", () => {
  const artifacts: Case["artifacts"] = [
    { id: "A01", kind: "contract", title: "Pay statement", description: "Salary survey." },
    { id: "A02", kind: "record", title: "Review invitations", description: "Editor emails.", claimed_criterion: "judging" },
  ];

  it("gives every exhibit an anchor and shows which findings name it", () => {
    const { container } = render(<EvidenceMatrix artifacts={artifacts} items={[PRONG, WAIVER]} />);
    expect(container.querySelector("#artifact-A01")?.textContent).toMatch(/Pay statement/);
    expect(container.querySelector("#artifact-A01")?.textContent).toMatch(/not claimed/);
    expect(container.querySelector("#artifact-A02")?.textContent).toMatch(/judging/);
    expect(within(container.querySelector("#artifact-A02") as HTMLElement).getByRole("link").getAttribute("href")).toBe("#item-prong-judging-whole");
  });
});

describe("History", () => {
  it("lists the review log oldest first with who did what", () => {
    render(<History events={[ev(1, "resolve", PRONG.id), ev(2, "signoff", null, "I reviewed every objection.")]} />);
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows[0]).toMatch(/Attorney A.*resolved.*judging \/ whole/);
    expect(rows[1]).toMatch(/Attorney A.*signed off/);
  });

  it("says when there is no history yet", () => {
    render(<History events={[]} />);
    expect(screen.getByText(/no review actions yet/i)).toBeTruthy();
  });
});

// --- phase-8 review fixes ----------------------------------------------------------------------

describe("refused actions", () => {
  it("show the reason next to the form and keep the attorney's note", async () => {
    const refuse = async () => ({ error: "prong:judging/whole is already resolved" });
    render(<ObjectionCard caseId="P01" item={PRONG} state={{ status: "open" }} dispose={refuse} />);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    const note = screen.getByLabelText(/attorney note/i) as HTMLTextAreaElement;
    await userEvent.type(note, "Exhibit 14 has the reports.");
    await userEvent.click(screen.getByRole("button", { name: /confirm resolve/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already resolved/);
    expect((screen.getByLabelText(/attorney note/i) as HTMLTextAreaElement).value).toBe("Exhibit 14 has the reports.");
  });
});

describe("PassageDrawer as a dialog", () => {
  const passage = {
    chunk_id: 1, decision_id: "JAN212026_02B2203", url: "https://www.uscis.gov/x.pdf", section_kind: "criterion",
    criterion: "judging", body: "Petitioners must show that they actually participated in judging.", start_char: 0, end_char: 9,
  };

  it("is modal and takes focus when it opens", () => {
    render(<PassageDrawer passage={passage} quote="Petitioners must show" closeHref="/cases/P01" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
  });

  it("closes on Escape", async () => {
    render(<PassageDrawer passage={passage} quote="Petitioners must show" closeHref="/cases/P01" />);
    let closed = false;
    screen.getByRole("link", { name: "Close" }).addEventListener("click", (e) => { e.preventDefault(); closed = true; });
    await userEvent.keyboard("{Escape}");
    expect(closed).toBe(true);
  });

  it("links only to an https source", () => {
    render(<PassageDrawer passage={{ ...passage, url: "javascript:alert(1)" }} quote="Petitioners must show" closeHref="/cases/P01" />);
    expect(screen.queryByRole("link", { name: /JAN212026_02B2203/ })).toBeNull();
    expect(screen.getByText("JAN212026_02B2203")).toBeTruthy();
  });
});

describe("sign-off name", () => {
  it("defaults to the reviewer the actions are logged under", () => {
    render(<ExportPanel caseId="P01" state={reviewState([PRONG], [ev(1, "resolve", PRONG.id)])} signoff={noop} reviewer="Attorney A" />);
    expect((screen.getByLabelText(/your full name/i) as HTMLInputElement).value).toBe("Attorney A");
  });
});
