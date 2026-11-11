/**
 * Adversarial examiner (Phase 5): for each prong of each claimed criterion, retrieve AAO
 * reasoning on that prong, then have the model argue the strongest RFE-style objection,
 * citing only what was retrieved. Every citation is validated after generation (passage was
 * retrieved, decision matches, quote verbatim); one corrective retry, then invalid citations
 * are pruned, and a review with none left is dropped and recorded — never shown ungrounded.
 */
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import { petitionSchema } from "@/lib/schemas/petition.zod";
import { prongReviewSchema } from "@/lib/schemas/prong_review.zod";
import { validateCitations, type CitationProblem, type Passage } from "./citations";
import type { PetitionInput } from "./mapper";
import { prongsFor, type Prong } from "./prongs";
import type { Retriever } from "./retriever";
import { criterionRisk, rfeRisk, UNREVIEWED_RISK } from "./risk";

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
1. addressed: taking each evidence description at face value (assume the documents say what the
   inventory says they say), is any filed evidence directed at THIS prong? If the evidence is
   silent on the prong, addressed is false. Doubts about weight, corroboration or sufficiency do
   not make it false: they go into risk and the objection.
2. Write the strongest objection an officer could raise on this prong in a Request for Evidence
   (if addressed, the weaknesses in weight or corroboration), addressed to the specific evidence
   and grounded in the AAO reasoning provided.
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

function describeProblems(problems: CitationProblem[]): string {
  return problems
    .map((p) => `- chunk ${p.citation.chunk_id} / ${p.citation.decision_id}: ${p.reason}`)
    .join("\n");
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

  const prompt = taskPrompt(task, passages);
  const attempt = async (feedback?: string): Promise<ProngReview | Error> => {
    try {
      const { output } = await generateText({
        model,
        system: EXAMINER_SYSTEM,
        prompt: feedback ? `${prompt}\n\n${feedback}` : prompt,
        output: Output.object({ schema: prongReviewSchema }),
        temperature: 0,
        maxOutputTokens,
        maxRetries: 0, // retries are hidden spend; the one corrective retry below is explicit
      });
      return output;
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) return err; // schema miss: worth one retry
      throw err; // transport/auth/budget: the caller must see it
    }
  };

  const first = await attempt();
  const firstProblems = first instanceof Error ? [] : validateCitations(first.citations, passages);
  if (!(first instanceof Error) && firstProblems.length === 0) {
    return { ...base, status: "reviewed", review: first, attempts: 1, first_attempt_problems: [], pruned: [] };
  }
  const feedback = first instanceof Error
    ? "Your previous answer did not match the required JSON schema. Answer again, exactly in the schema."
    : `Your previous answer had invalid citations:\n${describeProblems(firstProblems)}\n` +
      "Answer again. Cite only the passages listed above, with their exact chunk_id and decision_id, " +
      "and copy each quote character for character from that passage.";
  const second = await attempt(feedback);
  if (second instanceof Error) {
    return { ...base, status: "dropped", reason: "invalid_output", problems: firstProblems, attempts: 2, detail: second.message.slice(0, 300) };
  }
  const problems = validateCitations(second.citations, passages);
  const bad = new Set(problems.map((p) => p.citation));
  const kept = second.citations.filter((c) => !bad.has(c));
  if (kept.length === 0) {
    return { ...base, status: "dropped", reason: "invalid_citations", problems, attempts: 2 };
  }
  return {
    ...base,
    status: "reviewed",
    review: { ...second, citations: kept },
    attempts: 2,
    first_attempt_problems: firstProblems,
    pruned: problems,
  };
}

export interface ExaminerResult {
  petition_id: string;
  reviews: ReviewedProng[];
  dropped: DroppedProng[];
  criterion_risk: Record<string, number>;
  rfe_risk: number;
}

async function inOrder<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
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
    // A prong we could not ground is not a pass: it carries an explicit unknown risk.
    (prongRisks[o.criterion] ??= []).push(o.status === "reviewed" ? o.review.risk : UNREVIEWED_RISK);
  }
  const criterion_risk = Object.fromEntries(Object.entries(prongRisks).map(([c, r]) => [c, criterionRisk(r)]));
  return {
    petition_id: petition.id,
    reviews: outcomes.filter((o): o is ReviewedProng => o.status === "reviewed"),
    dropped: outcomes.filter((o): o is DroppedProng => o.status === "dropped"),
    criterion_risk,
    rfe_risk: rfeRisk(criterion_risk),
  };
}
