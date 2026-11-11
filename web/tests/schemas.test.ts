import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { petitionSchema } from "@/lib/schemas/petition.zod";
import { petitionMappingSchema } from "@/lib/schemas/petition_mapping.zod";

const root = path.resolve(__dirname, "..");
const cases = JSON.parse(readFileSync(path.resolve(root, "../eval/synthetic/phase4_petitions.json"), "utf8")) as {
  petition: unknown;
}[];

describe("Zod schemas generated from the Pydantic source of truth", () => {
  it("accept every Python-generated synthetic petition", () => {
    for (const c of cases) expect(petitionSchema.safeParse(c.petition).success).toBe(true);
  });

  it("reject what Pydantic rejects", () => {
    const p = structuredClone(cases[0].petition) as { artifacts: { id: string }[] };
    p.artifacts[0].id = "X1";
    expect(petitionSchema.safeParse(p).success).toBe(false);
    const m = { petition_id: "P01", mappings: [{ artifact_id: "A01", best_criterion: "judging", strength: 1.5, rationale: "r", scores: [] }] };
    expect(petitionMappingSchema.safeParse(m).success).toBe(false);
  });

  it("are exactly what the generator produces from the committed JSON Schema (no drift)", () => {
    const out = execFileSync(process.execPath, [path.join(root, "scripts/gen-zod.mjs"), "--stdout"], { encoding: "utf8" });
    const committed = ["petition", "petition_mapping"]
      .map((n) => readFileSync(path.join(root, `lib/schemas/${n}.zod.ts`), "utf8"))
      .join("\n// ---\n");
    expect(out).toBe(committed);
  });
});
