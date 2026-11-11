/**
 * Phase-5 scoring. Citations are re-verified against passages fetched fresh from the
 * database (not the examiner's own retrieved set), so "0 fabricated" is checked end to end.
 */
import { validateCitations, type Passage } from "./citations";
import type { ExaminerResult } from "./examiner";
import { PRONGS } from "./prongs";
import type { WaiverFinding } from "./waiver";

export interface ExaminerCase {
  petition_id: string;
  claimed: Record<string, string | null>; // artifact_id -> claimed criterion
  planted_halves: { artifact_id: string; criterion: string; missing_prongs: string[] }[];
  planted_unclaimed: { artifact_id: string; criterion: string }[];
  result: ExaminerResult;
  waiver: WaiverFinding[];
}

export interface ExaminerScore {
  petitions: number;
  objections: number;
  citations: number;
  fabricated_citations: number;
  fabricated: string[];
  first_attempt_invalid_citations: number;
  retried: number;
  dropped: Record<string, number>;
  mode_b: { planted: number; caught: number; missed: string[] };
  full_claim_prongs: { total: number; flagged: number };
  mode_d: { planted: number; caught: number; missed: string[]; other_unclaimed_findings: number };
  gate: { passed: boolean; failures: string[] };
}

export function scoreExaminer(
  cases: ExaminerCase[],
  db: Map<number, Passage>,
  { minObjections = 100 }: { minObjections?: number } = {},
): ExaminerScore {
  const s: ExaminerScore = {
    petitions: cases.length, objections: 0, citations: 0, fabricated_citations: 0, fabricated: [],
    first_attempt_invalid_citations: 0, retried: 0, dropped: {},
    mode_b: { planted: 0, caught: 0, missed: [] },
    full_claim_prongs: { total: 0, flagged: 0 },
    mode_d: { planted: 0, caught: 0, missed: [], other_unclaimed_findings: 0 },
    gate: { passed: false, failures: [] },
  };
  for (const c of cases) {
    const { reviews, dropped } = c.result;
    s.objections += reviews.length;
    for (const r of reviews) {
      s.first_attempt_invalid_citations += r.first_attempt_problems.length;
      if (r.attempts > 1) s.retried += 1;
      for (const cit of r.review.citations) {
        s.citations += 1;
        const row = db.get(cit.chunk_id);
        const problems = validateCitations([cit], row ? [row] : []);
        if (problems.length) {
          s.fabricated_citations += 1;
          s.fabricated.push(`${c.petition_id}/${r.criterion}/${r.prong}: chunk ${cit.chunk_id} ${problems[0].reason}`);
        }
      }
    }
    for (const d of dropped) {
      s.dropped[d.reason] = (s.dropped[d.reason] ?? 0) + 1;
      if (d.attempts > 1) s.retried += 1;
    }

    const review = (criterion: string, prong: string) => reviews.find((r) => r.criterion === criterion && r.prong === prong);
    const halfCriteria = new Set(c.planted_halves.map((h) => h.criterion));
    for (const h of c.planted_halves) {
      s.mode_b.planted += 1;
      const caught = h.missing_prongs.every((p) => review(h.criterion, p)?.review.established === false);
      if (caught) s.mode_b.caught += 1;
      else s.mode_b.missed.push(`${c.petition_id}/${h.criterion}/${h.missing_prongs.join("+")}`);
    }
    const fullTwoPart = new Set(
      Object.values(c.claimed).filter((x): x is string => x !== null && x in PRONGS && !halfCriteria.has(x)),
    );
    for (const r of reviews) {
      if (!fullTwoPart.has(r.criterion)) continue;
      s.full_claim_prongs.total += 1;
      if (!r.review.established) s.full_claim_prongs.flagged += 1;
    }

    const unclaimed = c.waiver.filter((w) => w.kind === "unclaimed_supported");
    for (const u of c.planted_unclaimed) {
      s.mode_d.planted += 1;
      if (unclaimed.some((w) => w.criterion === u.criterion && w.artifact_ids.includes(u.artifact_id))) s.mode_d.caught += 1;
      else s.mode_d.missed.push(`${c.petition_id}/${u.criterion}/${u.artifact_id}`);
    }
    s.mode_d.other_unclaimed_findings += unclaimed.filter(
      (w) => !c.planted_unclaimed.some((u) => u.criterion === w.criterion),
    ).length;
  }
  const f = s.gate.failures;
  if (s.objections < minObjections) f.push(`only ${s.objections} objections (< ${minObjections})`);
  if (s.fabricated_citations > 0) f.push(`${s.fabricated_citations} fabricated citation(s)`);
  if (s.mode_b.caught < s.mode_b.planted) f.push(`mode B: ${s.mode_b.caught}/${s.mode_b.planted} planted halves caught`);
  if (s.mode_d.caught < s.mode_d.planted) f.push(`mode D: ${s.mode_d.caught}/${s.mode_d.planted} planted waivers caught`);
  s.gate.passed = f.length === 0;
  return s;
}
