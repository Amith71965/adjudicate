/**
 * Phase-6 merits gate. Each pair is a strong and a weak petition that both pass step one; the
 * expected verdicts hold by construction. Gate: every weak petition judged unfavorable (the
 * catch a pre-filing reviewer exists for), every pair ordered by at least minMargin of risk,
 * 0 fabricated citations (re-verified against passages fetched fresh), nothing dropped.
 * A strong petition judged unfavorable is reported (strong_favorable, accuracy), not gated:
 * the binary call on a strong record flipped between runs on small wording changes while the
 * ordering held, and final-merits precedent comes from mostly dismissed appeals (ADR-016).
 */
import { validateCitations, type Passage } from "@/lib/examiner/citations";
import type { MeritsOutcome } from "./merits";

export interface MeritsCase {
  petition_id: string;
  tier: "strong" | "weak";
  pair: number;
}

export interface MeritsScore {
  cases: number;
  dropped: number;
  pairs: number;
  ordered_pairs: number;
  min_margin: number; // smallest risk(weak) - risk(strong) over pairs with both reviewed
  weak_caught: number; // weak petitions judged unfavorable
  strong_favorable: number; // strong petitions judged favorable (reported, not gated)
  accuracy: number;
  confusion: { strong_favorable: number; strong_unfavorable: number; weak_favorable: number; weak_unfavorable: number };
  citations: number;
  fabricated_citations: number;
  fabricated: string[];
  gate: { passed: boolean; failures: string[] };
}

export function scoreMerits(
  cases: MeritsCase[],
  outcomes: MeritsOutcome[],
  db: Map<number, Passage>,
  { minMargin = 0.2 }: { minMargin?: number } = {},
): MeritsScore {
  if (outcomes.length !== cases.length) throw new Error(`need one outcome per case: ${cases.length} cases, ${outcomes.length} outcomes`);
  const confusion = { strong_favorable: 0, strong_unfavorable: 0, weak_favorable: 0, weak_unfavorable: 0 };
  const risk = new Map<string, number>();
  let dropped = 0, correct = 0, citations = 0;
  const fabricated: string[] = [];
  cases.forEach((c, i) => {
    const o = outcomes[i];
    if (o.petition_id !== c.petition_id) throw new Error(`outcome ${i} is for ${o.petition_id}, expected ${c.petition_id}`);
    if (o.status !== "reviewed") {
      dropped++;
      return;
    }
    const favorable = o.review.sustained_acclaim && o.review.top_of_field;
    confusion[`${c.tier}_${favorable ? "favorable" : "unfavorable"}`]++;
    if (favorable === (c.tier === "strong")) correct++;
    risk.set(c.petition_id, o.review.risk);
    citations += o.review.citations.length;
    const fresh = o.review.citations.flatMap((x) => { const p = db.get(x.chunk_id); return p ? [p] : []; });
    for (const p of validateCitations(o.review.citations, fresh)) {
      fabricated.push(`${c.petition_id}: chunk ${p.citation.chunk_id} ${p.reason}`);
    }
  });
  const pairIds = [...new Set(cases.map((c) => c.pair))];
  const margins = pairIds.flatMap((p) => {
    const s = cases.find((c) => c.pair === p && c.tier === "strong");
    const w = cases.find((c) => c.pair === p && c.tier === "weak");
    const rs = s && risk.get(s.petition_id);
    const rw = w && risk.get(w.petition_id);
    return rs !== undefined && rw !== undefined ? [rw - rs] : [];
  });
  const ordered = margins.filter((m) => m > 0).length;
  const minMarginSeen = margins.length === 0 ? 0 : Math.min(...margins);
  const weakCases = cases.filter((c) => c.tier === "weak").length;
  const accuracy = cases.length === 0 ? 0 : correct / cases.length;
  const failures: string[] = [];
  if (cases.length === 0) failures.push("no cases");
  if (ordered < pairIds.length) failures.push(`${ordered}/${pairIds.length} pairs ordered (strong less risky than weak)`);
  if (confusion.weak_unfavorable < weakCases) {
    failures.push(`${weakCases - confusion.weak_unfavorable} weak petition(s) not judged unfavorable`);
  }
  if (margins.length > 0 && minMarginSeen < minMargin) failures.push(`smallest risk margin ${minMarginSeen.toFixed(3)} < ${minMargin}`);
  if (fabricated.length > 0) failures.push(`${fabricated.length} fabricated citation(s)`);
  if (dropped > 0) failures.push(`${dropped} merits review(s) dropped unreviewed`);
  return {
    cases: cases.length, dropped, pairs: pairIds.length, ordered_pairs: ordered, min_margin: minMarginSeen,
    weak_caught: confusion.weak_unfavorable, strong_favorable: confusion.strong_favorable, accuracy, confusion,
    citations, fabricated_citations: fabricated.length, fabricated,
    gate: { passed: failures.length === 0, failures },
  };
}
