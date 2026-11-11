/** Scoring for the Phase-4 exit gate (pure; the runner lives in web/scripts/eval-mapper.ts). */
export interface ScoredCase {
  truth: Record<string, string | null>;
  predicted: Record<string, string | null>;
  planted: string[];
  flagged: string[];
}

export interface MapperScore {
  artifacts: number;
  top1: number;
  modeARecall: number;
  falseFlags: number;
}

export function scoreMapper(cases: ScoredCase[]): MapperScore {
  if (cases.length === 0) throw new Error("cannot score an empty case set");
  let artifacts = 0, correct = 0, planted = 0, caught = 0, falseFlags = 0;
  for (const c of cases) {
    for (const [id, truth] of Object.entries(c.truth)) {
      artifacts += 1;
      if ((c.predicted[id] ?? null) === truth) correct += 1;
    }
    const flagged = new Set(c.flagged);
    planted += c.planted.length;
    caught += c.planted.filter((id) => flagged.has(id)).length;
    falseFlags += c.flagged.filter((id) => !c.planted.includes(id)).length;
  }
  return { artifacts, top1: correct / artifacts, modeARecall: planted ? caught / planted : 1, falseFlags };
}
