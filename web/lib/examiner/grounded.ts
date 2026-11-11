/**
 * Grounded generation: the model answers in a schema that carries citations, and every citation
 * is validated against the passages it was given (retrieved, matching decision, verbatim quote).
 * One corrective retry naming each problem; then invalid citations are pruned, and an answer
 * with none left is dropped — never shown ungrounded. Only a schema miss is retried; transport,
 * auth and budget errors propagate. Shared by the examiner (step one) and the merits pass.
 */
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import { validateCitations, type Citation, type CitationProblem, type Passage } from "./citations";

export type Grounded<T> =
  | { status: "ok"; value: T; attempts: 1 | 2; first_attempt_problems: CitationProblem[]; pruned: CitationProblem[] }
  | { status: "dropped"; reason: "invalid_output" | "invalid_citations"; attempts: 2; problems: CitationProblem[]; detail?: string };

export function describeProblems(problems: CitationProblem[]): string {
  return problems.map((p) => `- chunk ${p.citation.chunk_id} / ${p.citation.decision_id}: ${p.reason}`).join("\n");
}

export async function generateGrounded<T extends { citations: Citation[] }>(options: {
  model: LanguageModel;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  passages: Passage[];
  maxOutputTokens: number;
}): Promise<Grounded<T>> {
  const { model, system, prompt, schema, passages, maxOutputTokens } = options;
  const attempt = async (feedback?: string): Promise<T | Error> => {
    try {
      const { output } = await generateText({
        model,
        system,
        prompt: feedback ? `${prompt}\n\n${feedback}` : prompt,
        output: Output.object({ schema }),
        temperature: 0,
        maxOutputTokens,
        maxRetries: 0, // retries are hidden spend; the one corrective retry below is explicit
      });
      return output as T;
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) return err; // schema miss: worth one retry
      throw err; // transport/auth/budget: the caller must see it
    }
  };

  const first = await attempt();
  const firstProblems = first instanceof Error ? [] : validateCitations(first.citations, passages);
  if (!(first instanceof Error) && firstProblems.length === 0) {
    return { status: "ok", value: first, attempts: 1, first_attempt_problems: [], pruned: [] };
  }
  const feedback = first instanceof Error
    ? "Your previous answer did not match the required JSON schema. Answer again, exactly in the schema."
    : `Your previous answer had invalid citations:\n${describeProblems(firstProblems)}\n` +
      "Answer again. Cite only the passages listed above, with their exact chunk_id and decision_id, " +
      "and copy each quote character for character from that passage.";
  const second = await attempt(feedback);
  if (second instanceof Error) {
    return { status: "dropped", reason: "invalid_output", attempts: 2, problems: firstProblems, detail: second.message.slice(0, 300) };
  }
  const problems = validateCitations(second.citations, passages);
  const bad = new Set(problems.map((p) => p.citation));
  const kept = second.citations.filter((c) => !bad.has(c));
  if (kept.length === 0) return { status: "dropped", reason: "invalid_citations", attempts: 2, problems };
  return { status: "ok", value: { ...second, citations: kept }, attempts: 2, first_attempt_problems: firstProblems, pruned: problems };
}
