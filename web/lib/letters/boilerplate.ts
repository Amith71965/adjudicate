/**
 * Cross-letter boilerplate: letters drafted from one template share long verbatim runs. Words
 * are normalized (lowercase, punctuation dropped) and cut into k-word shingles; a pair is flagged
 * when it shares at least `minShared` shingles, i.e. a common run of k + minShared - 1 words.
 * Stock phrases ("the work of Dr. X has") are shorter than that. Exact shingle sets, not
 * MinHash: a petition has at most a few dozen letters, so all pairs are cheap to compare.
 */
export interface BoilerplatePair {
  a: string;
  b: string;
  shared: number; // shingles in common
  passage: string; // the longest shared run, normalized
}

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);

export function shingles(text: string, k: number): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

function longestSharedRun(text: string, shared: Set<string>, k: number): string {
  const w = words(text);
  const covered = new Array<boolean>(w.length).fill(false);
  for (let i = 0; i + k <= w.length; i++) {
    if (shared.has(w.slice(i, i + k).join(" "))) covered.fill(true, i, i + k);
  }
  let best: [number, number] = [0, 0];
  for (let i = 0; i < w.length; ) {
    if (!covered[i]) { i++; continue; }
    let j = i;
    while (j < w.length && covered[j]) j++;
    if (j - i > best[1] - best[0]) best = [i, j];
    i = j;
  }
  return w.slice(...best).join(" ");
}

export function boilerplatePairs(
  letters: { id: string; sentences: string[] }[],
  { k = 8, minShared = 4 }: { k?: number; minShared?: number } = {},
): BoilerplatePair[] {
  const texts = letters.map((l) => l.sentences.join(" "));
  const sets = texts.map((t) => shingles(t, k));
  const pairs: BoilerplatePair[] = [];
  for (let i = 0; i < letters.length; i++) {
    for (let j = i + 1; j < letters.length; j++) {
      const shared = new Set([...sets[i]].filter((s) => sets[j].has(s)));
      if (shared.size >= minShared) {
        pairs.push({ a: letters[i].id, b: letters[j].id, shared: shared.size, passage: longestSharedRun(texts[i], shared, k) });
      }
    }
  }
  return pairs;
}
