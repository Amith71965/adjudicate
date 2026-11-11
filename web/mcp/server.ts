/**
 * MCP server exposing the AAO reasoning corpus as agent tools, by proxying the
 * retrieval API. Every API failure surfaces as an explicit tool error (`isError`):
 * an agent must never read "corpus down" as "no precedent found".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type FetchLike = (url: string) => Promise<Response>;

export interface ServerOptions {
  apiBase: string;
  fetch?: FetchLike;
}

interface Hit {
  rank: number;
  decision_id: string;
  chunk_id: number;
  url: string;
  section_kind: string;
  criterion: string | null;
  snippet: string;
}

class ApiError extends Error {}

const CRITERIA = [
  "awards", "membership", "published_material", "judging", "original_contributions",
  "scholarly_articles", "display", "leading_role", "high_salary", "commercial_success",
] as const;

export function createServer({ apiBase, fetch: fetchImpl = (u) => fetch(u) }: ServerOptions): McpServer {
  const server = new McpServer({ name: "adjudicate", version: "0.3.0" });

  async function get(path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
    const url = new URL(path, apiBase);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    let res: Response;
    try {
      res = await fetchImpl(url.toString());
    } catch (err) {
      throw new ApiError(`retrieval API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body: unknown = await res.json().catch(() => ({}));
    const detail = (body as { detail?: unknown }).detail ?? res.statusText;
    if (res.status === 404) throw new ApiError(`not found: ${String(detail)}`);
    if (!res.ok) throw new ApiError(`retrieval API error ${res.status}: ${String(detail)}`);
    return body;
  }

  const fail = (err: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  });

  server.registerTool(
    "search_reasoning",
    {
      title: "Search AAO reasoning",
      description:
        "Hybrid (vector + lexical) search over USCIS Administrative Appeals Office reasoning on " +
        "extraordinary-ability petitions. Returns one passage per decision with its source URL. " +
        "Use it to find how the AAO has treated a fact pattern before citing it.",
      inputSchema: {
        query: z.string().trim().min(1).max(2000).describe("Fact pattern or legal issue in plain English"),
        k: z.number().int().min(1).max(50).default(10),
        mode: z.enum(["hybrid", "vector", "lexical"]).default("hybrid"),
        visa: z.enum(["EB-1A", "O-1", "EB-2/NIW"]).optional(),
        criterion: z.enum(CRITERIA).optional(),
      },
    },
    async ({ query, k, mode, visa, criterion }) => {
      try {
        const body = (await get("/search", { q: query, k: String(k), mode, visa, criterion })) as { results: Hit[] };
        const text = body.results.length
          ? body.results
              .map((h) => `${h.rank}. ${h.decision_id} [${h.section_kind}${h.criterion ? `:${h.criterion}` : ""}] ${h.url}\n   "${h.snippet.slice(0, 300)}"`)
              .join("\n")
          : "No matching AAO reasoning found.";
        return { content: [{ type: "text" as const, text }], structuredContent: { results: body.results } };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_decision",
    {
      title: "Get an AAO decision",
      description: "Outcome, sections and grounded per-criterion verdicts (Director vs AAO) for one decision id, e.g. SEP152026_01B2203.",
      inputSchema: { decision_id: z.string().regex(/^[A-Za-z0-9_]{6,40}$/) },
    },
    async ({ decision_id }) => {
      try {
        const body = await get(`/decisions/${encodeURIComponent(decision_id)}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], structuredContent: body as Record<string, unknown> };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_passage",
    {
      title: "Get an exact passage",
      description: "Exact text of one retrieved passage (chunk_id from search_reasoning), with its decision and source URL — for verbatim citation.",
      inputSchema: { chunk_id: z.number().int().positive() },
    },
    async ({ chunk_id }) => {
      try {
        const body = await get(`/passages/${chunk_id}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], structuredContent: body as Record<string, unknown> };
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
