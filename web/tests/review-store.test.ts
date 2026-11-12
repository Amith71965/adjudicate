/**
 * The review UI's server-side client for the FastAPI review log and AAO passages, and the
 * quote locator behind the citation drawer. Failures are loud: a down log must never look
 * like an empty history, and a quote that is not in its passage is flagged, not hidden.
 */
import { describe, expect, it } from "vitest";
import { httpReviewStore, locateQuote, ReviewStoreError } from "@/lib/review/store";

type Call = { url: string; init?: RequestInit };
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const EVENT = { id: 1, case_id: "P01", item_id: "prong:judging/whole", action: "resolve", note: "Added reports.", actor: "A", created_at: "2026-11-12T10:00:00Z" };

describe("httpReviewStore", () => {
  it("lists a case's events", async () => {
    const { fn, calls } = fakeFetch([json({ case_id: "P01", events: [EVENT] })]);
    expect(await httpReviewStore("http://api/", fn).events("P01")).toEqual([EVENT]);
    expect(calls[0].url).toBe("http://api/cases/P01/events");
  });

  it("appends an event with a JSON POST", async () => {
    const { fn, calls } = fakeFetch([json(EVENT, 201)]);
    const out = await httpReviewStore("http://api", fn).append("P01", { item_id: EVENT.item_id, action: "resolve", note: EVENT.note, actor: "A" });
    expect(out).toEqual(EVENT);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ action: "resolve", item_id: EVENT.item_id });
  });

  it("refuses to build a URL from a case id that is not one", async () => {
    const { fn, calls } = fakeFetch([]);
    await expect(httpReviewStore("http://api", fn).events("../health")).rejects.toThrow(ReviewStoreError);
    expect(calls).toEqual([]);
  });

  it("turns an outage or a refusal into an error, never an empty history", async () => {
    const down = fakeFetch([json({ detail: "corpus database unavailable" }, 503)]);
    await expect(httpReviewStore("http://api", down.fn).events("P01")).rejects.toThrow(/503/);
    const refused = fakeFetch([json({ detail: "an attorney note is required" }, 422)]);
    await expect(
      httpReviewStore("http://api", refused.fn).append("P01", { item_id: null, action: "signoff", note: "", actor: "A" }),
    ).rejects.toThrow(/422.*note/);
  });

  it("rejects a malformed body", async () => {
    const { fn } = fakeFetch([json({ events: "nope" })]);
    await expect(httpReviewStore("http://api", fn).events("P01")).rejects.toThrow(/malformed/);
  });

  it("fetches a full passage by chunk id", async () => {
    const p = { chunk_id: 7, decision_id: "JAN012026_01B2203", url: "https://www.uscis.gov/x.pdf", section_kind: "criterion", criterion: "judging", body: "text", start_char: 0, end_char: 4 };
    const { fn, calls } = fakeFetch([json(p)]);
    expect(await httpReviewStore("http://api", fn).passage(7)).toEqual(p);
    expect(calls[0].url).toBe("http://api/passages/7");
  });
});

describe("locateQuote", () => {
  const body = "The record shows invitations.  Petitioners must show that they\nactually participated in judging. More text.";

  it("finds a verbatim quote even across line breaks and double spaces", () => {
    const at = locateQuote(body, "Petitioners must show that they actually participated in judging.");
    expect(at).not.toBeNull();
    expect(body.slice(at![0], at![1]).replace(/\s+/g, " ")).toBe("Petitioners must show that they actually participated in judging.");
  });

  it("returns null when the quote is not in the passage", () => {
    expect(locateQuote(body, "The petitioner clearly meets the judging criterion.")).toBeNull();
  });
});
