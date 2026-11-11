/**
 * Failure mode D, pre-filing form: arguments not raised now cannot be raised on appeal
 * (Matter of O-R-E-, 28 I&N Dec. 330, 336 n.5 (BIA 2021) — confirmed present in the corpus).
 */
export const SUPPORT_THRESHOLD = 0.5;
const WAIVER_AUTHORITY = "Matter of O-R-E-, 28 I&N Dec. 330, 336 n.5 (BIA 2021)";

export interface WaiverFinding {
  kind: "unclaimed_supported" | "claimed_unsupported" | "below_three";
  criterion?: string;
  artifact_ids: string[];
  message: string;
}

/** Only what the rule reads: per-artifact criterion strengths (a PetitionMapping fits). */
interface StrengthMapping {
  mappings: { artifact_id: string; scores: { criterion: string; strength: number }[] }[];
}

interface ClaimedArtifact {
  id: string;
  claimed_criterion?: string | null;
}

export function waiverFindings(artifacts: ClaimedArtifact[], mapping: StrengthMapping): WaiverFinding[] {
  const mapped = new Set(mapping.mappings.map((m) => m.artifact_id));
  const unmapped = artifacts.filter((a) => !mapped.has(a.id)).map((a) => a.id);
  if (unmapped.length) {
    // An unmapped artifact is unknown, not unsupported: refuse rather than mislabel it.
    throw new Error(`mapping incomplete: no scores for ${unmapped.join(", ")}`);
  }
  const claimed = new Map<string, string[]>();
  for (const a of artifacts) {
    if (a.claimed_criterion) claimed.set(a.claimed_criterion, [...(claimed.get(a.claimed_criterion) ?? []), a.id]);
  }
  const supported = new Map<string, string[]>();
  for (const m of mapping.mappings) {
    for (const s of m.scores) {
      if (s.strength >= SUPPORT_THRESHOLD) supported.set(s.criterion, [...(supported.get(s.criterion) ?? []), m.artifact_id]);
    }
  }
  const findings: WaiverFinding[] = [];
  for (const [criterion, ids] of supported) {
    if (!claimed.has(criterion)) {
      findings.push({
        kind: "unclaimed_supported", criterion, artifact_ids: ids,
        message: `Evidence supports ${criterion} but the petition does not claim it. Claim it now: an argument not raised before USCIS is waived on appeal (${WAIVER_AUTHORITY}).`,
      });
    }
  }
  for (const [criterion, ids] of claimed) {
    const backing = ids.filter((id) => (supported.get(criterion) ?? []).includes(id));
    if (backing.length === 0) {
      findings.push({ kind: "claimed_unsupported", criterion, artifact_ids: ids,
        message: `The petition claims ${criterion}, but none of the evidence filed under it supports that criterion.` });
    }
  }
  const viable = [...claimed.keys()].filter((c) => (supported.get(c) ?? []).some((id) => claimed.get(c)?.includes(id)));
  if (viable.length < 3) {
    findings.push({ kind: "below_three", artifact_ids: [],
      message: `Only ${viable.length} claimed criteria are supported by the evidence filed under them; at least three are required (8 C.F.R. § 204.5(h)(3)).` });
  }
  return findings;
}
