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
  reason: "chunk_not_retrieved" | "decision_mismatch" | "quote_not_verbatim";
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function validateCitations(citations: Citation[], retrieved: Passage[]): CitationProblem[] {
  const byId = new Map(retrieved.map((p) => [p.chunk_id, p]));
  const problems: CitationProblem[] = [];
  for (const c of citations) {
    const p = byId.get(c.chunk_id);
    if (!p) problems.push({ citation: c, reason: "chunk_not_retrieved" });
    else if (p.decision_id !== c.decision_id) problems.push({ citation: c, reason: "decision_mismatch" });
    else if (!c.quote.trim() || !squash(p.body).includes(squash(c.quote))) problems.push({ citation: c, reason: "quote_not_verbatim" });
  }
  return problems;
}
