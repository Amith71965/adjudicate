import { describe, expect, it, vi } from "vitest";
import { checkDb, type Queryable } from "@/lib/health";

const fakeClient = (rows: Record<string, unknown>[]): Queryable => ({
  query: vi.fn().mockResolvedValue({ rows }),
});

describe("checkDb", () => {
  it("reports ok with the pgvector version when the extension is present", async () => {
    const result = await checkDb(fakeClient([{ extversion: "0.8.1" }]));
    expect(result).toEqual({ ok: true, vector: "0.8.1" });
  });

  it("reports not ok when pgvector is missing, instead of pretending all is well", async () => {
    const result = await checkDb(fakeClient([]));
    expect(result).toEqual({ ok: false, error: "pgvector extension not installed" });
  });

  it("surfaces the driver error message when the query throws", async () => {
    const client: Queryable = { query: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    const result = await checkDb(client);
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});
