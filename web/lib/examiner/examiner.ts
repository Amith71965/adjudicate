/**
 * Adversarial examiner (Phase 5): for each prong of each claimed criterion, retrieve AAO
 * reasoning on that prong, then have the model argue the strongest RFE-style objection,
 * citing only what was retrieved. Every citation is validated after generation (passage was
 * retrieved, decision matches, quote verbatim); one corrective retry, then invalid citations
 * are pruned, and a review with none left is dropped and recorded — never shown ungrounded.
 */
import type { LanguageModel } from "ai";
import type { z } from "zod";
import { petitionSchema } from "@/lib/schemas/petition.zod";
import { prongReviewSchema } from "@/lib/schemas/prong_review.zod";
import type { CitationProblem, Passage } from "./citations";
import { generateGrounded } from "./grounded";
import type { PetitionInput } from "./mapper";
import { prongsFor, type Prong } from "./prongs";
import type { Retriever } from "./retriever";
import { criterionRisk, FACIAL_FAIL_RISK, rfeRisk, UNREVIEWED_RISK } from "./risk";

export type { Retriever } from "./retriever";
export type ProngReview = z.infer<typeof prongReviewSchema>;

const CRITERION_TEXT: Record<string, string> = {
  awards: "lesser nationally or internationally recognized prizes or awards for excellence",
  membership: "membership in associations that require outstanding achievements of their members",
  published_material: "published material about the beneficiary in professional or major media",
  judging: "participation as a judge of the work of others in the field",
  original_contributions: "original contributions of major significance to the field",
  scholarly_articles: "authorship of scholarly articles in the field",
  display: "display of the beneficiary's work at artistic exhibitions or showcases",
  leading_role: "a leading or critical role for organizations with a distinguished reputation",
  high_salary: "a high salary or remuneration in relation to others in the field",
  commercial_success: "commercial success in the performing arts",
};

export const EXAMINER_SYSTEM = `You are a skeptical USCIS officer adjudicating an EB-1A petition under
8 C.F.R. § 204.5(h)(3). You examine ONE prong of ONE criterion at a time.
1. facially_met: taking each evidence description at face value (assume the documents are genuine
   and say what the inventory says), does the evidence meet THIS prong? It is false when the
   evidence is silent on the prong, or when what it shows fails the prong (for example, a
   passing mention is not material about the beneficiary). Doubts about genuineness,
   corroboration or weight do not make it false: they go into risk and the objection.
2. Write the strongest objection an officer could raise on this prong in a Request for Evidence
   (if facially met, the weaknesses in weight or corroboration), addressed to the specific
   evidence and grounded in the AAO reasoning provided.
3. risk: the likelihood (0-1) that this prong draws an RFE or a denial.
4. Cite 1-3 of the AAO passages provided: chunk_id and decision_id exactly as given, and a quote
   of 30-300 characters copied character for character from that passage. Cite nothing else.`;

export interface ReviewTask {
  criterion: string;
  prong: Prong;
  artifacts: { id: string; kind: string; title: string; description: string }[];
}

interface Outcome {
  criterion: string;
  prong: string;
  artifact_ids: string[];
  attempts: number;
  retrieved_chunk_ids: number[];
}
export interface ReviewedProng extends Outcome {
  status: "reviewed";
  review: ProngReview;
  first_attempt_problems: CitationProblem[];
  pruned: CitationProblem[];
}
export interface DroppedProng extends Outcome {
  status: "dropped";
  reason: "no_passages" | "invalid_citations" | "invalid_output";
  problems: CitationProblem[];
  detail?: string;
}
export type ProngOutcome = ReviewedProng | DroppedProng;

export function reviewTasks(input: PetitionInput): ReviewTask[] {
  const petition = petitionSchema.parse(input);
  const claimed = [...new Set(petition.artifacts.map((a) => a.claimed_criterion).filter((c) => c != null))];
  return claimed.flatMap((criterion) => {
    const artifacts = petition.artifacts
      .filter((a) => a.claimed_criterion === criterion)
      .map(({ id, kind, title, description }) => ({ id, kind, title, description }));
    return prongsFor(criterion).map((prong) => ({ criterion, prong, artifacts }));
  });
}

function taskPrompt(task: ReviewTask, passages: Passage[]): string {
  const sources = passages.map((p) => `[chunk_id ${p.chunk_id} | decision_id ${p.decision_id}]\n${p.body}`).join("\n\n");
  return [
    `Criterion: ${task.criterion} (${CRITERION_TEXT[task.criterion] ?? task.criterion})`,
    `Prong under examination: ${task.prong.test}`,
    `Evidence filed under this criterion:\n${JSON.stringify(task.artifacts, null, 2)}`,
    `AAO passages (the only citable sources):\n\n${sources}`,
  ].join("\n\n");
}

export async function examineProng(
  task: ReviewTask,
  { model, retriever, k = 6, maxOutputTokens = 6000 }: { model: LanguageModel; retriever: Retriever; k?: number; maxOutputTokens?: number },
): Promise<ProngOutcome> {
  const query = `${CRITERION_TEXT[task.criterion] ?? task.criterion}: ${task.prong.test}`;
  const passages = await retriever.search(query, { criterion: task.criterion, visa: "EB-1A", k });
  const base = {
    criterion: task.criterion,
    prong: task.prong.id,
    artifact_ids: task.artifacts.map((a) => a.id),
    retrieved_chunk_ids: passages.map((p) => p.chunk_id),
  };
  if (passages.length === 0) return { ...base, status: "dropped", reason: "no_passages", problems: [], attempts: 0 };

  const out = await generateGrounded({
    model, system: EXAMINER_SYSTEM, prompt: taskPrompt(task, passages), schema: prongReviewSchema, passages, maxOutputTokens,
  });
  if (out.status === "dropped") {
    const { status, reason, attempts, problems, detail } = out;
    return { ...base, status, reason, attempts, problems, ...(detail === undefined ? {} : { detail }) };
  }
  return {
    ...base,
    status: "reviewed",
    review: out.value,
    attempts: out.attempts,
    first_attempt_problems: out.first_attempt_problems,
    pruned: out.pruned,
  };
}

export interface ExaminerResult {
  petition_id: string;
  reviews: ReviewedProng[];
  dropped: DroppedProng[];
  complete: boolean; // false: some prongs could not be reviewed with grounded citations
  unreviewed: string[]; // "criterion/prong" of each dropped review
  criterion_risk: Record<string, number>;
  rfe_risk: number;
}

/** Bounded-concurrency map that keeps input order and starts nothing new after a failure. */
export async function inOrder<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        failed = true; // other workers finish their in-flight item, then stop spending
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export async function examinePetition(
  input: PetitionInput,
  options: { model: LanguageModel; retriever: Retriever; concurrency?: number; k?: number },
): Promise<ExaminerResult> {
  const petition = petitionSchema.parse(input);
  const outcomes = await inOrder(reviewTasks(petition), options.concurrency ?? 1, (t) => examineProng(t, options));
  const prongRisks: Record<string, number[]> = {};
  for (const o of outcomes) {
    const risk = o.status === "dropped"
      ? UNREVIEWED_RISK // could not ground it: never a pass
      : o.review.facially_met ? o.review.risk : Math.max(o.review.risk, FACIAL_FAIL_RISK);
    (prongRisks[o.criterion] ??= []).push(risk);
  }
  const dropped = outcomes.filter((o): o is DroppedProng => o.status === "dropped");
  const criterion_risk = Object.fromEntries(Object.entries(prongRisks).map(([c, r]) => [c, criterionRisk(r)]));
  return {
    petition_id: petition.id,
    reviews: outcomes.filter((o): o is ReviewedProng => o.status === "reviewed"),
    dropped,
    complete: dropped.length === 0,
    unreviewed: dropped.map((d) => `${d.criterion}/${d.prong}`),
    criterion_risk,
    rfe_risk: rfeRisk(criterion_risk),
  };
}
