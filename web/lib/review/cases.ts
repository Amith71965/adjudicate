/**
 * Review cases (Phase 8): a synthetic petition + its committed examiner run, turned into the
 * list of AI claims an attorney must dispose of before export. Opening a case never calls a
 * model. Only the petition itself is kept: the synthetic answer key stays in the eval files.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { petitionSchema } from "@/lib/schemas/petition.zod";
import type { PetitionInput } from "@/lib/examiner/mapper";
import { prongsFor } from "@/lib/examiner/prongs";
import { FACIAL_FAIL_RISK, UNREVIEWED_RISK } from "@/lib/examiner/risk";

export interface Citation {
  chunk_id: number;
  decision_id: string;
  quote: string;
}

interface RecordedReview {
  criterion: string;
  prong: string;
  artifact_ids: string[];
  facially_met: boolean;
  risk: number;
  objection: string;
  citations: Citation[];
}
interface RecordedWaiver {
  kind: string;
  criterion: string;
  artifact_ids: string[];
  message: string;
}
interface RecordedDrop {
  criterion: string;
  prong: string;
  artifact_ids: string[];
  reason: string;
}

/** One petition's entry in eval/results/phase5_examiner.json. */
export interface RecordedRun {
  petition_id: string;
  rfe_risk: number;
  criterion_risk: Record<string, number>;
  complete: boolean;
  reviews: RecordedReview[];
  waiver: RecordedWaiver[];
  dropped: RecordedDrop[];
}

interface ItemBase {
  id: string;
  criterion: string;
  artifact_ids: string[];
  /** Ordering only: how likely this item draws an RFE (waiver findings sort last). */
  rank: number;
}
export interface ProngItem extends ItemBase {
  kind: "prong";
  prong: string;
  test: string; // what the prong requires, in words
  facially_met: boolean;
  risk: number;
  objection: string;
  citations: Citation[];
}
export interface WaiverItem extends ItemBase {
  kind: "waiver";
  finding: string; // unclaimed_supported | claimed_unsupported
  message: string;
}
export interface ManualItem extends ItemBase {
  kind: "manual";
  prong: string;
  test: string;
  reason: string;
}
export type ReviewItem = ProngItem | WaiverItem | ManualItem;

export interface Case {
  id: string;
  field: string;
  beneficiary: string;
  artifacts: PetitionInput["artifacts"];
  items: ReviewItem[];
  criterion_risk: Record<string, number>;
  rfe_risk: number;
  complete: boolean;
  run: { model: string; cache_version: string };
}

const testFor = (criterion: string, prong: string) =>
  prongsFor(criterion).find((p) => p.id === prong)?.test ?? prong;

export function buildCase(input: PetitionInput, run: RecordedRun, meta: Case["run"]): Case {
  const petition = petitionSchema.parse(input) as PetitionInput;
  if (run.petition_id !== petition.id) {
    throw new Error(`run for ${run.petition_id} cannot be shown as case ${petition.id}`);
  }
  const known = new Set(petition.artifacts.map((a) => a.id));
  const checkEvidence = (where: string, ids: string[]) => {
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) throw new Error(`${petition.id} ${where} names evidence it does not have: ${missing.join(", ")}`);
  };

  const items: ReviewItem[] = [];
  for (const r of run.reviews) {
    const id = `prong:${r.criterion}/${r.prong}`;
    if (r.citations.length === 0) throw new Error(`${petition.id} ${id} has no citation: an ungrounded objection is never shown`);
    for (const c of r.citations) {
      if (!Number.isInteger(c.chunk_id) || c.chunk_id < 1) throw new Error(`${petition.id} ${id} cites chunk ${c.chunk_id}: not a passage`);
      if (!c.decision_id.trim()) throw new Error(`${petition.id} ${id} cites a passage with no decision id`);
      if (c.quote.trim().length < 30) throw new Error(`${petition.id} ${id} cites a quote too short to check (${JSON.stringify(c.quote)})`);
    }
    checkEvidence(id, r.artifact_ids);
    items.push({
      kind: "prong", id, criterion: r.criterion, prong: r.prong, test: testFor(r.criterion, r.prong),
      artifact_ids: r.artifact_ids, facially_met: r.facially_met, risk: r.risk, objection: r.objection,
      citations: r.citations, rank: r.facially_met ? r.risk : Math.max(r.risk, FACIAL_FAIL_RISK),
    });
  }
  for (const d of run.dropped) {
    const id = `manual:${d.criterion}/${d.prong}`;
    checkEvidence(id, d.artifact_ids);
    items.push({
      kind: "manual", id, criterion: d.criterion, prong: d.prong, test: testFor(d.criterion, d.prong),
      artifact_ids: d.artifact_ids, reason: d.reason, rank: UNREVIEWED_RISK,
    });
  }
  for (const w of run.waiver) {
    const id = `waiver:${w.kind}:${w.criterion}`;
    checkEvidence(id, w.artifact_ids);
    items.push({ kind: "waiver", id, criterion: w.criterion, finding: w.kind, artifact_ids: w.artifact_ids, message: w.message, rank: -1 });
  }
  items.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));

  return {
    id: petition.id,
    field: petition.field,
    beneficiary: petition.beneficiary,
    artifacts: petition.artifacts,
    items,
    criterion_risk: run.criterion_risk,
    rfe_risk: run.rfe_risk,
    complete: run.complete,
    run: meta,
  };
}

/** The 16 synthetic Phase-5 petitions with their committed examiner run. `root` = repo root. */
export function loadCases(root: string): Case[] {
  const read = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));
  const petitions = read("eval/synthetic/phase5_petitions.json") as { petition: PetitionInput }[];
  const results = read("eval/results/phase5_examiner.json") as { model: string; cache_version: string; petitions: RecordedRun[] };
  const runs = new Map(results.petitions.map((r) => [r.petition_id, r]));
  return petitions
    .map(({ petition }) => {
      const run = runs.get(petition.id);
      if (!run) throw new Error(`no recorded examiner run for ${petition.id}`);
      return buildCase(petition, run, { model: results.model, cache_version: results.cache_version });
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
