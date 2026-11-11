import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "@/mcp/server";

const API = "http://api.test";

type FetchLike = (url: string) => Promise<Response>;

async function connect(fetchImpl: FetchLike) {
  const server = createServer({ apiBase: API, fetch: fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HIT = {
  rank: 1, decision_id: "NOV212025_01B2203", chunk_id: 42, url: "https://www.uscis.gov/x.pdf",
  visa_type: "EB-1A", outcome: "dismissed", section_kind: "criterion", criterion: "leading_role",
  snippet: "these documents do not sufficiently discuss or otherwise establish the distinguished reputation",
};

describe("adjudicate MCP server", () => {
  it("exposes exactly the three corpus tools", async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_decision", "get_passage", "search_reasoning"]);
  });

  it("search_reasoning proxies to the API and returns citable hits", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json({ results: [HIT] }));
    const client = await connect(fetchImpl);
    const res = await client.callTool({ name: "search_reasoning", arguments: { query: "distinguished reputation", k: 5 } });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("distinguished reputation");
    expect(url.searchParams.get("k")).toBe("5");
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("NOV212025_01B2203");
    expect(text).toContain("https://www.uscis.gov/x.pdf");
    expect(res.structuredContent).toMatchObject({ results: [{ decision_id: "NOV212025_01B2203" }] });
  });

  it("reports an API outage as a tool error, never as 'no results'", async () => {
    const client = await connect(vi.fn<FetchLike>().mockResolvedValue(json({ detail: "corpus database unavailable" }, 503)));
    const res = await client.callTool({ name: "search_reasoning", arguments: { query: "acclaim" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/unavailable/);
  });

  it("reports a network failure as a tool error", async () => {
    const client = await connect(vi.fn<FetchLike>().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await client.callTool({ name: "get_passage", arguments: { chunk_id: 1 } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/ECONNREFUSED/);
  });

  it("get_decision surfaces a 404 as an explicit not-found error", async () => {
    const client = await connect(vi.fn<FetchLike>().mockResolvedValue(json({ detail: "no decision X" }, 404)));
    const res = await client.callTool({ name: "get_decision", arguments: { decision_id: "NOPE12345" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/not found/i);
  });

  it("rejects out-of-range k before calling the API", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const client = await connect(fetchImpl);
    const res = await client.callTool({ name: "search_reasoning", arguments: { query: "x", k: 0 } });
    expect(res.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("adjudicate MCP server — malformed API responses", () => {
  it("treats a non-JSON 200 body as an error, not an empty result", async () => {
    const client = await connect(vi.fn<FetchLike>().mockResolvedValue(new Response("<html>proxy</html>", { status: 200 })));
    const res = await client.callTool({ name: "get_passage", arguments: { chunk_id: 1 } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/not JSON/i);
  });

  it("rejects a search body without a results array", async () => {
    const client = await connect(vi.fn<FetchLike>().mockResolvedValue(json({ hits: [] })));
    const res = await client.callTool({ name: "search_reasoning", arguments: { query: "x" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/unexpected/i);
  });
});
