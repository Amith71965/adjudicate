/**
 * Superlative lexicon: the cheap baseline for mode C (assertion without mechanism). It flags
 * "the most accurate system: error fell from 4.1 to 2.3" (a superlative WITH a mechanism) and
 * misses "the importance of this work cannot be overstated" (vague, no superlative word), so
 * it is reported next to the LLM detector, never used as the detector.
 */
const TERMS = [
  "most", "best", "finest", "greatest", "strongest", "foremost", "top", "leading", "preeminent",
  "brilliant", "exceptional", "exceptionally", "extraordinary", "outstanding", "remarkable",
  "unparalleled", "unprecedented", "unique", "world-class", "phenomenal", "elite", "rare",
  "gifted", "forefront", "impressive", "truly", "renowned", "stellar", "superb",
];
const PATTERN = new RegExp(`(?<![\\w-])(${TERMS.join("|")})(?![\\w-])`, "gi");

export function superlativeHits(sentence: string): string[] {
  return [...sentence.matchAll(PATTERN)].map((m) => m[1].toLowerCase());
}

export function lexiconLabel(sentence: string): "assertion" | "other" {
  return superlativeHits(sentence).length > 0 ? "assertion" : "other";
}
