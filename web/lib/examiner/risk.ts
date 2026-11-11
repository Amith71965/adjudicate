/**
 * RFE risk. A criterion fails if any of its prongs fails; the petition needs at least three
 * criteria to survive (8 C.F.R. § 204.5(h)(3)). Prong risks are treated as independent —
 * a simplification, stated as such wherever the score is shown.
 */

/**
 * A prong the examiner could not review with grounded citations is treated as failing: we
 * cannot vouch for it, so it must never lower the score. Results carry `complete: false`.
 */
export const UNREVIEWED_RISK = 1;
/** A prong the evidence does not facially meet will draw an RFE, whatever the model's number. */
export const FACIAL_FAIL_RISK = 0.8;

function checkProbability(p: number): void {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new RangeError(`not a probability: ${p}`);
}

/** P(at least k of the independent events occur) — the Poisson-binomial tail. */
export function probAtLeast(probabilities: number[], k: number): number {
  if (k <= 0) return 1;
  let dist = [1]; // dist[j] = P(exactly j events so far)
  for (const p of probabilities) {
    checkProbability(p);
    const next = new Array<number>(dist.length + 1).fill(0);
    dist.forEach((v, j) => {
      next[j] += v * (1 - p);
      next[j + 1] += v * p;
    });
    dist = next;
  }
  return dist.slice(k).reduce((a, b) => a + b, 0);
}

export function criterionRisk(prongRisks: number[]): number {
  if (prongRisks.length === 0) throw new RangeError("a criterion has at least one prong");
  prongRisks.forEach(checkProbability);
  return 1 - prongRisks.reduce((pass, r) => pass * (1 - r), 1);
}

export function rfeRisk(criterionRisks: Record<string, number>, needed = 3): number {
  return 1 - probAtLeast(Object.values(criterionRisks).map((r) => 1 - r), needed);
}
