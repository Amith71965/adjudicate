/**
 * Kazarian step two (final merits), a pass separate from the per-criterion examiner: given that
 * step one is met, does the totality of the record show sustained national or international
 * acclaim and a place among the small percentage at the very top of the field? Grounded in
 * retrieved AAO final-merits reasoning with the same citation validation as the examiner; a
 * review whose citations cannot be grounded is dropped and recorded, never shown.
 */
import type { LanguageModel } from "ai";
import type { z } from "zod";
import type { CitationProblem } from "@/lib/examiner/citations";
import { generateGrounded } from "@/lib/examiner/grounded";
import type { Retriever } from "@/lib/examiner/retriever";
import type { PacketReview } from "@/lib/letters/mechanism";
import { meritsInputSchema } from "@/lib/schemas/merits_input.zod";
import { meritsReviewSchema } from "@/lib/schemas/merits_review.zod";

export type MeritsInput = z.infer<typeof meritsInputSchema>;
export type MeritsReview = z.infer<typeof meritsReviewSchema>;
export type LetterSummary = MeritsInput["letters"];

export const MERITS_SYSTEM = `You make the final merits determination for an EB-1A petition (Kazarian v. USCIS,
596 F.3d 1115 (9th Cir. 2010), step two). Step one is done: each criterion listed was judged met.
Meeting three criteria is not enough. Weigh the totality of the record and decide:
- sustained_acclaim: does the evidence show sustained national or international acclaim?
- top_of_field: is the beneficiary one of the small percentage who have risen to the very top of
  the field (8 C.F.R. § 204.5(h)(2))? Compare the evidence with what is routine for people in
  the field: activity that most active professionals also show is not acclaim.
Recommendation letters weigh less when they praise without specifics, repeat boilerplate, or come
from people tied to the beneficiary while presented as independent.
risk: the likelihood (0-1) that the final merits determination is adverse.
reasoning: address the specific evidence, as an officer would in a decision.
Cite 1-3 of the AAO passages provided: chunk_id and decision_id exactly as given, and a quote of
30-300 characters copied character for character from that passage. Cite nothing else.`;

export const MERITS_QUERY =
  "final merits determination totality of the evidence sustained national or international acclaim " +
  "small percentage who have risen to the very top of the field";

interface Outcome {
  petition_id: string;
  attempts: number;
  retrieved_chunk_ids: number[];
}
export interface ReviewedMerits extends Outcome {
  status: "reviewed";
  review: MeritsReview;
  first_attempt_problems: CitationProblem[];
  pruned: CitationProblem[];
}
export interface DroppedMerits extends Outcome {
  status: "dropped";
  reason: "no_passages" | "invalid_output" | "invalid_citations";
  problems: CitationProblem[];
  detail?: string;
}
export type MeritsOutcome = ReviewedMerits | DroppedMerits;

/** Letter findings for step two. An unreviewed letter counts as weak: unknown is never a pass. */
export function letterSummary(review: PacketReview): LetterSummary {
  const reviewed = review.letters.filter((l) => l.status === "reviewed");
  const sentences = reviewed.reduce((n, l) => n + l.labels.length, 0);
  const assertions = reviewed.reduce((n, l) => n + l.assertions.length, 0);
  return {
    letters: review.letters.length,
    independent: review.independence.filter((t) => t.claimed_independent && !t.violation).length,
    weak: review.letters.filter((l) => l.status === "dropped" || l.weak).length,
    assertion_share: sentences === 0 ? 1 : Math.round((assertions / sentences) * 1e4) / 1e4,
    boilerplate_pairs: review.boilerplate.length,
    independence_violations: review.independence.filter((t) => t.violation).length,
  };
}

export async function meritsPass(
  raw: MeritsInput,
  { model, retriever, k = 6, maxOutputTokens = 4000 }: { model: LanguageModel; retriever: Retriever; k?: number; maxOutputTokens?: number },
): Promise<MeritsOutcome> {
  const input = meritsInputSchema.parse(raw);
  const passages = await retriever.search(MERITS_QUERY, { section: "final_merits", visa: "EB-1A", k });
  const base = { petition_id: input.petition.id, retrieved_chunk_ids: passages.map((p) => p.chunk_id) };
  if (passages.length === 0) return { ...base, status: "dropped", reason: "no_passages", problems: [], attempts: 0 };

  const evidence = input.petition.artifacts.map(({ id, kind, title, description, claimed_criterion }) => ({ id, kind, title, description, claimed_criterion }));
  const prompt = [
    `Field: ${input.petition.field}`,
    `Step one (criteria judged met, with the examiner's residual risk):\n${JSON.stringify(input.step_one)}`,
    `Evidence inventory:\n${JSON.stringify(evidence, null, 2)}`,
    `Recommendation letter findings:\n${JSON.stringify(input.letters)}`,
    `AAO final-merits passages (the only citable sources):\n\n${passages.map((p) => `[chunk_id ${p.chunk_id} | decision_id ${p.decision_id}]\n${p.body}`).join("\n\n")}`,
  ].join("\n\n");
  const out = await generateGrounded({ model, system: MERITS_SYSTEM, prompt, schema: meritsReviewSchema, passages, maxOutputTokens });
  if (out.status === "dropped") {
    const { status, reason, attempts, problems, detail } = out;
    return { ...base, status, reason, attempts, problems, ...(detail === undefined ? {} : { detail }) };
  }
  return { ...base, status: "reviewed", review: out.value, attempts: out.attempts, first_attempt_problems: out.first_attempt_problems, pruned: out.pruned };
}
