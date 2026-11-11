/**
 * Phase-6 letter gate: mode C (assertion without mechanism) at the sentence level, with the
 * superlative-lexicon baseline beside it; planted boilerplate pairs; planted independence
 * violations (and the near misses that must not be flagged). A dropped letter's assertions
 * count as missed: an unreviewed letter is never a pass.
 */
import { lexiconLabel } from "./lexicon";
import type { PacketReview } from "./mechanism";
import type { LetterPacket } from "./types";

export interface LetterCase {
  packet: LetterPacket;
  kinds: Record<string, string[]>; // letter id -> kind per sentence (assertion_*, mechanism_*, context)
  planted_boilerplate: string[][]; // sorted letter-id pairs
  planted_violations: { letter_id: string; kind: string }[];
  near_misses: { letter_id: string; kind: string }[];
}

interface PR { tp: number; fp: number; fn: number; precision: number; recall: number }
const pr = (tp: number, fp: number, fn: number): PR => ({
  tp, fp, fn,
  precision: tp + fp === 0 ? 0 : tp / (tp + fp),
  recall: tp + fn === 0 ? 0 : tp / (tp + fn),
});

export interface LetterScore {
  letters: number;
  sentences: number;
  dropped: number;
  mode_c: PR & { by_kind: Record<string, { n: number; flagged: number }> };
  lexicon: PR;
  boilerplate: { planted: number; found: number; false_pairs: number; precision: number; recall: number };
  independence: { planted: number; found: number; false_violations: number; near_misses_flagged: number; precision: number; recall: number };
  gate: { passed: boolean; failures: string[] };
}

export function scoreLetters(
  cases: LetterCase[],
  reviews: PacketReview[],
  { minRecall = 0.9, minPrecision = 0.8, maxDroppedRatio = 0.05 } = {},
): LetterScore {
  if (reviews.length !== cases.length) throw new Error(`need one review per case: ${cases.length} cases, ${reviews.length} reviews`);
  const c = { tp: 0, fp: 0, fn: 0 };
  const lx = { tp: 0, fp: 0, fn: 0 };
  const byKind: Record<string, { n: number; flagged: number }> = {};
  const bp = { planted: 0, found: 0, false_pairs: 0 };
  const ind = { planted: 0, found: 0, false_violations: 0, near_misses_flagged: 0 };
  let letters = 0, sentences = 0, dropped = 0;

  cases.forEach((cs, i) => {
    const review = reviews[i];
    if (review.petition_id !== cs.packet.petition_id) {
      throw new Error(`review ${i} is for ${review.petition_id}, expected ${cs.packet.petition_id}`);
    }
    const outcomes = new Map(review.letters.map((l) => [l.letter_id, l]));
    for (const letter of cs.packet.letters) {
      letters++;
      const out = outcomes.get(letter.id);
      if (out?.status !== "reviewed") dropped++;
      letter.sentences.forEach((sentence, j) => {
        sentences++;
        const kind = cs.kinds[letter.id][j];
        const positive = kind.startsWith("assertion");
        const flagged = out?.status === "reviewed" && out.labels[j] === "assertion";
        const entry = (byKind[kind] ??= { n: 0, flagged: 0 });
        entry.n++;
        if (flagged) entry.flagged++;
        if (positive && flagged) c.tp++; else if (flagged) c.fp++; else if (positive) c.fn++;
        const lex = lexiconLabel(sentence) === "assertion";
        if (positive && lex) lx.tp++; else if (lex) lx.fp++; else if (positive) lx.fn++;
      });
    }

    const planted = new Set(cs.planted_boilerplate.map((p) => p.join("|")));
    const found = new Set(review.boilerplate.map((p) => [p.a, p.b].sort().join("|")));
    bp.planted += planted.size;
    for (const p of found) if (planted.has(p)) bp.found++; else bp.false_pairs++;

    const violations = new Set(cs.planted_violations.map((v) => v.letter_id));
    const near = new Set(cs.near_misses.map((m) => m.letter_id));
    ind.planted += violations.size;
    for (const t of review.independence) {
      if (!t.violation) continue;
      if (violations.has(t.letter_id)) ind.found++;
      else ind.false_violations++;
      if (near.has(t.letter_id)) ind.near_misses_flagged++;
    }
  });

  const mode_c = { ...pr(c.tp, c.fp, c.fn), by_kind: byKind };
  const boilerplate = {
    ...bp,
    precision: bp.found + bp.false_pairs === 0 ? 0 : bp.found / (bp.found + bp.false_pairs),
    recall: bp.planted === 0 ? 0 : bp.found / bp.planted,
  };
  const independence = {
    ...ind,
    precision: ind.found + ind.false_violations === 0 ? 0 : ind.found / (ind.found + ind.false_violations),
    recall: ind.planted === 0 ? 0 : ind.found / ind.planted,
  };
  const failures: string[] = [];
  const pct = (x: number) => x.toFixed(3);
  if (mode_c.recall < minRecall) failures.push(`mode C recall ${pct(mode_c.recall)} < ${minRecall}`);
  if (mode_c.precision < minPrecision) failures.push(`mode C precision ${pct(mode_c.precision)} < ${minPrecision}`);
  if (bp.planted === 0 || ind.planted === 0) failures.push("nothing planted: the boilerplate and independence checks would pass vacuously");
  if (bp.planted > 0 && boilerplate.recall < 1) failures.push(`boilerplate: ${bp.found}/${bp.planted} planted pairs found`);
  if (bp.planted > 0 && boilerplate.precision < minPrecision) failures.push(`boilerplate precision ${pct(boilerplate.precision)} < ${minPrecision}`);
  if (ind.planted > 0 && independence.recall < 1) failures.push(`independence: ${ind.found}/${ind.planted} planted violations found`);
  if (ind.planted > 0 && independence.precision < minPrecision) failures.push(`independence precision ${pct(independence.precision)} < ${minPrecision}`);
  if (letters > 0 && dropped / letters > maxDroppedRatio) failures.push(`${dropped}/${letters} letters dropped unreviewed`);

  return {
    letters, sentences, dropped, mode_c, lexicon: pr(lx.tp, lx.fp, lx.fn), boilerplate, independence,
    gate: { passed: failures.length === 0, failures },
  };
}
