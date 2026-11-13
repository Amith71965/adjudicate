/**
 * U2 proxy routes the browser uses for previews and the decision viewer. The FastAPI service is
 * server-side only; these routes validate ids, pass through what the reviewer needs, and turn
 * a missing decision into a 404 and an outage into a 503 (never an empty preview).
 */
import { describe, expect, it } from "vitest";
import { makeLocateHandler, makePassageHandler, makePdfHandler } from "@/lib/review/viewer-routes";
import { ReviewStoreError, type DecisionStore, type Passage } from "@/lib/review/store";

const PASSAGE: Passage = {
  chunk_id: 7, decision_id: "AUG172026_02B2203", url: "https://www.uscis.gov/x.pdf", section_kind: "criterion",
  criterion: "original_contributions", body: "Expert letters should specifically describe a petitioner's contribution.", start_char: 0, end_char: 70,
};
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]).buffer;

function store(over: Partial<{ passage: () => Promise<Passage>; pdf: () => Promise<ArrayBuffer>; locate: () => Promise<{ page: number | null; pages: number }> }> = {}) {
  return {
    passage: over.passage ?? (async () => PASSAGE),
    decisionPdf: over.pdf ?? (async () => PDF),
    locate: over.locate ?? (async () => ({ page: 3, pages: 5 })),
  } satisfies { passage(id: number): Promise<Passage> } & DecisionStore;
}
const notFound = async (): Promise<never> => { throw new ReviewStoreError("http://api/x answered 404: no stored PDF"); };
const down = async (): Promise<never> => { throw new ReviewStoreError("request to http://api/x failed: ECONNREFUSED"); };

describe("passage preview route", () => {
  it("returns the passage for a valid chunk id", async () => {
    const res = await makePassageHandler(store())("7");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chunk_id: 7, decision_id: "AUG172026_02B2203", body: PASSAGE.body });
  });

  it.each([["abc", 400], ["0", 400], ["-3", 400]])("refuses chunk id %s", async (id, status) => {
    expect((await makePassageHandler(store())(id)).status).toBe(status);
  });

  it("is a 404 for a missing passage and a 503 when the service is down", async () => {
    expect((await makePassageHandler(store({ passage: notFound }))("7")).status).toBe(404);
    expect((await makePassageHandler(store({ passage: down }))("7")).status).toBe(503);
  });
});

describe("decision PDF route", () => {
  it("streams the PDF inline", async () => {
    const res = await makePdfHandler(store())("AUG172026_02B2203");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PDF));
  });

  it("refuses a malformed id, and maps missing and down", async () => {
    expect((await makePdfHandler(store())("../etc")).status).toBe(400);
    expect((await makePdfHandler(store({ pdf: notFound }))("AUG172026_02B2203")).status).toBe(404);
    expect((await makePdfHandler(store({ pdf: down }))("AUG172026_02B2203")).status).toBe(503);
  });
});

describe("locate route", () => {
  it("returns the page of a quote", async () => {
    const res = await makeLocateHandler(store())("AUG172026_02B2203", "Expert letters should describe");
    expect(await res.json()).toEqual({ page: 3, pages: 5 });
  });

  it("needs a quote", async () => {
    expect((await makeLocateHandler(store())("AUG172026_02B2203", "")).status).toBe(400);
  });
});
