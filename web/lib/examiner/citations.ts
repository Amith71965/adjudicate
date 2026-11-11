/** Citation validation: every cited passage must be one we retrieved, and every quote verbatim. */
export interface Passage {
  chunk_id: number;
  decision_id: string;
  body: string;
}

export interface Citation {
  chunk_id: number;
  decision_id: string;
  quote: string;
}

export interface CitationProblem {
  citation: Citation;
  reason: "chunk_not_retrieved" | "decision_mismatch" | "quote_too_short" | "quote_not_verbatim" | "duplicate";
}

/** Long enough that a verbatim match is evidence, not coincidence ("the record" is not). */
export const MIN_QUOTE_CHARS = 30;

// Whitespace-insensitive (PDF line breaks), but case-sensitive: verbatim means verbatim.
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function validateCitations(citations: Citation[], retrieved: Passage[]): CitationProblem[] {
  const byId = new Map(retrieved.map((p) => [p.chunk_id, p]));
  const seen = new Set<string>();
  const problems: CitationProblem[] = [];
  for (const c of citations) {
    const p = byId.get(c.chunk_id);
    const quote = squash(c.quote);
    const key = `${c.chunk_id}\u0000${quote}`;
    if (!p) problems.push({ citation: c, reason: "chunk_not_retrieved" });
    else if (p.decision_id !== c.decision_id) problems.push({ citation: c, reason: "decision_mismatch" });
    else if (quote.length < MIN_QUOTE_CHARS) problems.push({ citation: c, reason: "quote_too_short" });
    else if (!squash(p.body).includes(quote)) problems.push({ citation: c, reason: "quote_not_verbatim" });
    else if (seen.has(key)) problems.push({ citation: c, reason: "duplicate" });
    seen.add(key);
  }
  return problems;
}
