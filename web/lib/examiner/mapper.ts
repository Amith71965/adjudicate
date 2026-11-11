/**
 * Evidence → criterion mapper (Phase 4). Scores every artifact against all ten EB-1A
 * criteria (the artifacts x criteria matrix) and flags failure mode A: evidence filed
 * under a criterion it does not support.
 *
 * The model maps each artifact *blind* — the draft petition's claimed criterion is not
 * shown to it, so it cannot anchor on the claim; mismatches are found by comparison.
 */
import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import { petitionSchema } from "@/lib/schemas/petition.zod";
import { petitionMappingSchema } from "@/lib/schemas/petition_mapping.zod";

export type PetitionInput = z.input<typeof petitionSchema>;
export type Petition = z.infer<typeof petitionSchema>;
export type PetitionMapping = z.infer<typeof petitionMappingSchema>;

export class MapperError extends Error {}

export const CRITERIA = [
  "awards", "membership", "published_material", "judging", "original_contributions",
  "scholarly_articles", "display", "leading_role", "high_salary", "commercial_success",
] as const;
export const MISMATCH_THRESHOLD = 0.5;

export const SYSTEM = `You are a meticulous U.S. immigration paralegal reviewing an EB-1A evidence
inventory against the ten criteria of 8 C.F.R. § 204.5(h)(3)(i)-(x):
awards (i) lesser nationally/internationally recognized prizes for excellence;
membership (ii) associations requiring outstanding achievements, judged by recognized experts;
published_material (iii) material ABOUT the beneficiary in major media or trade/professional publications;
judging (iv) participation as a judge of others' work in the field;
original_contributions (v) original contributions of major significance to the field;
scholarly_articles (vi) scholarly articles AUTHORED BY the beneficiary;
display (vii) display of the beneficiary's work at artistic exhibitions or showcases;
leading_role (viii) leading or critical role for organizations with a distinguished reputation;
high_salary (ix) high salary or remuneration relative to others in the field;
commercial_success (x) commercial success in the performing arts (box office / sales).

For EVERY artifact, score how well it supports EACH of the ten criteria from 0 to 1 (exactly one
score per criterion), set best_criterion to the highest-scoring criterion, or null if none scores
at least 0.3, set strength to that best score, and give a one-sentence rationale citing the
artifact's own content. Judge only what the artifact shows; do not assume facts not described.`;

function validateCoverage(petition: Petition, mapping: PetitionMapping): void {
  const expected = new Set(petition.artifacts.map((a) => a.id));
  const seen = new Set<string>();
  for (const m of mapping.mappings) {
    if (!expected.has(m.artifact_id)) throw new MapperError(`mapping invents artifact ${m.artifact_id}`);
    if (seen.has(m.artifact_id)) throw new MapperError(`artifact ${m.artifact_id} mapped twice`);
    seen.add(m.artifact_id);
    const crits = new Set(m.scores.map((s) => s.criterion));
    if (m.scores.length !== 10 || CRITERIA.some((c) => !crits.has(c))) {
      throw new MapperError(`artifact ${m.artifact_id}: scores must cover the ten criteria exactly once`);
    }
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new MapperError(`mapping is missing artifact(s) ${missing.join(", ")}`);
}

export async function mapPetition(
  input: PetitionInput,
  { model, maxOutputTokens = 12000 }: { model: LanguageModel; maxOutputTokens?: number },
): Promise<PetitionMapping> {
  const petition = petitionSchema.parse(input);
  const blind = {
    petition_id: petition.id,
    field: petition.field,
    artifacts: petition.artifacts.map(({ id, kind, title, description }) => ({ id, kind, title, description })),
  };
  const { output } = await generateText({
    model,
    system: SYSTEM,
    prompt: `Map this evidence inventory:\n${JSON.stringify(blind, null, 2)}`,
    output: Output.object({ schema: petitionMappingSchema }),
    temperature: 0,
    maxOutputTokens,
  });
  const mapping = petitionMappingSchema.parse(output);
  validateCoverage(petition, mapping);
  return mapping;
}

export interface Mismatch {
  artifact_id: string;
  claimed: string;
  suggested: string | null;
  claimed_strength: number;
  best_strength: number;
}

/** Mode A: the claimed criterion is weakly supported and a different criterion fits best. */
export function findMismatches(
  input: PetitionInput,
  mapping: PetitionMapping,
  threshold = MISMATCH_THRESHOLD,
): Mismatch[] {
  const petition = petitionSchema.parse(input);
  const byId = new Map(mapping.mappings.map((m) => [m.artifact_id, m]));
  const flags: Mismatch[] = [];
  for (const a of petition.artifacts) {
    const m = byId.get(a.id);
    if (!a.claimed_criterion || !m) continue;
    const claimedStrength = m.scores.find((s) => s.criterion === a.claimed_criterion)?.strength ?? 0;
    if (m.best_criterion !== a.claimed_criterion && claimedStrength < threshold) {
      flags.push({
        artifact_id: a.id,
        claimed: a.claimed_criterion,
        suggested: m.best_criterion,
        claimed_strength: claimedStrength,
        best_strength: m.strength,
      });
    }
  }
  return flags;
}
