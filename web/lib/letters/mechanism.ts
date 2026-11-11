/**
 * Mode C detector: label every sentence of a recommendation letter as mechanism, assertion or
 * context. Officers give little weight to letters that praise without saying what the person
 * did and what checkable consequence followed; a letter with no mechanism at all is "weak".
 * Labels point at sentences by index, so the output cannot misquote a letter. Coverage is
 * validated (every sentence labelled exactly once); one corrective retry, then the letter is
 * dropped and recorded as unreviewed. Transport errors propagate.
 */
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { inOrder } from "@/lib/examiner/examiner";
import { letterReviewSchema } from "@/lib/schemas/letter_review.zod";
import { boilerplatePairs, type BoilerplatePair } from "./boilerplate";
import { independenceTies, type LetterTies } from "./independence";
import type { Letter, LetterPacket, LetterReview, SentenceLabel } from "./types";

export const LETTER_SYSTEM = `You weigh one expert recommendation letter filed with an EB-1A petition, sentence
by sentence, the way a USCIS officer does: specific, checkable statements carry weight; praise
without specifics does not. Label every numbered sentence exactly once:
- mechanism: says what the beneficiary specifically did AND a concrete consequence someone could
  check (a figure, a named adopter or user, a benchmark result, a procedure or standard that
  changed). Superlative wording does not matter when that consequence is stated.
- assertion: claims importance, impact, originality, influence, acclaim or rank without saying
  what was done or what checkable consequence followed. Echoing the regulatory language
  ("original contributions of major significance", "sustained acclaim") is an assertion.
- context: the author's own background, how they know the work, or the purpose of the letter;
  no claim about the merit of the beneficiary's work.
Give each label a reason of at most 20 words.`;

interface Outcome {
  letter_id: string;
  attempts: number;
}
export interface ReviewedLetter extends Outcome {
  status: "reviewed";
  labels: SentenceLabel[];
  reasons: string[];
  assertions: number[]; // indices of mode-C sentences
  weak: boolean; // no sentence states a mechanism
  first_attempt_problems: string[];
}
export interface DroppedLetter extends Outcome {
  status: "dropped";
  reason: "invalid_coverage" | "invalid_output";
  problems: string[];
}
export type LetterOutcome = ReviewedLetter | DroppedLetter;

export function coverageProblems(review: LetterReview, n: number): string[] {
  const seen = new Map<number, number>();
  for (const v of review.sentences) seen.set(v.index, (seen.get(v.index) ?? 0) + 1);
  const problems: string[] = [];
  for (let i = 0; i < n; i++) {
    if (!seen.has(i)) problems.push(`sentence ${i} has no label`);
    else if ((seen.get(i) ?? 0) > 1) problems.push(`sentence ${i} is labelled more than once`);
  }
  for (const i of [...seen.keys()].sort((a, b) => a - b)) {
    if (i >= n) problems.push(`sentence ${i} does not exist (the letter has ${n})`);
  }
  return problems;
}

export async function reviewLetter(
  letter: Letter,
  { model, field, maxOutputTokens }: { model: LanguageModel; field: string; maxOutputTokens?: number },
): Promise<LetterOutcome> {
  const n = letter.sentences.length;
  // ~60 tokens per labelled sentence (index, label, short reason): a fixed cap truncates long letters
  const budget = maxOutputTokens ?? Math.max(3000, 60 * n + 600);
  const prompt = [
    `Field: ${field}`,
    `Letter (${n} sentences, numbered from 0):`,
    letter.sentences.map((s, i) => `[${i}] ${s}`).join("\n"),
  ].join("\n\n");
  const attempt = async (feedback?: string): Promise<LetterReview | Error> => {
    try {
      const { output } = await generateText({
        model,
        system: LETTER_SYSTEM,
        prompt: feedback ? `${prompt}\n\n${feedback}` : prompt,
        output: Output.object({ schema: letterReviewSchema }),
        temperature: 0,
        maxOutputTokens: budget,
        maxRetries: 0, // hidden retries are hidden spend; the corrective retry below is explicit
      });
      return output;
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) return err;
      throw err;
    }
  };

  const base = { letter_id: letter.id };
  const accept = (review: LetterReview, attempts: number, first_attempt_problems: string[]): ReviewedLetter => {
    const ordered = [...review.sentences].sort((a, b) => a.index - b.index);
    const labels = ordered.map((v) => v.label);
    return {
      ...base,
      status: "reviewed",
      attempts,
      labels,
      reasons: ordered.map((v) => v.reason),
      assertions: labels.flatMap((l, i) => (l === "assertion" ? [i] : [])),
      weak: !labels.includes("mechanism"),
      first_attempt_problems,
    };
  };

  const first = await attempt();
  const firstProblems = first instanceof Error ? [] : coverageProblems(first, n);
  if (!(first instanceof Error) && firstProblems.length === 0) return accept(first, 1, []);
  const feedback = first instanceof Error
    ? "Your previous answer did not match the required JSON schema. Answer again, exactly in the schema."
    : `Your previous answer did not label each sentence exactly once:\n${firstProblems.map((p) => `- ${p}`).join("\n")}\n` +
      `Answer again with exactly one label for each index from 0 to ${n - 1}.`;
  const second = await attempt(feedback);
  if (second instanceof Error) {
    return { ...base, status: "dropped", reason: "invalid_output", attempts: 2, problems: [...firstProblems, second.message.slice(0, 300)] };
  }
  const problems = coverageProblems(second, n);
  if (problems.length > 0) return { ...base, status: "dropped", reason: "invalid_coverage", attempts: 2, problems };
  return accept(second, 2, firstProblems);
}

export interface PacketReview {
  petition_id: string;
  letters: LetterOutcome[];
  boilerplate: BoilerplatePair[];
  independence: LetterTies[];
  complete: boolean; // false: some letters could not be reviewed
  unreviewed: string[];
}

export async function reviewPacket(
  packet: LetterPacket,
  { model, concurrency = 1 }: { model: LanguageModel; concurrency?: number },
): Promise<PacketReview> {
  const letters = await inOrder(packet.letters, concurrency, (l) => reviewLetter(l, { model, field: packet.field }));
  const unreviewed = letters.filter((l) => l.status === "dropped").map((l) => l.letter_id);
  return {
    petition_id: packet.petition_id,
    letters,
    boilerplate: boilerplatePairs(packet.letters),
    independence: independenceTies(packet),
    complete: unreviewed.length === 0,
    unreviewed,
  };
}
