/**
 * Which PDF.js text items make up a cited quote, so the viewer highlights exactly those words.
 * Items are joined with a space and compared case- and whitespace-insensitively. If the whole
 * quote is not there (an OCR repair changed a character), its opening words are tried. Too-short
 * probes are never guessed; nothing found means nothing highlighted.
 */
const MIN = 24;
const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function quoteItems(items: string[], quote: string): number[] {
  const target = flat(quote);
  if (target.length < MIN) return [];
  const ranges: [number, number][] = [];
  let text = "";
  for (const item of items) {
    const piece = flat(item);
    if (text && piece) text += " ";
    const start = text.length;
    text += piece;
    ranges.push([start, text.length]);
  }
  for (const probe of [target, target.slice(0, 80), target.slice(0, 48)]) {
    if (probe.length < MIN) break;
    const at = text.indexOf(probe.trim());
    if (at < 0) continue;
    const end = at + probe.trim().length;
    return ranges.flatMap(([s, e], i) => (e > at && s < end && e > s ? [i] : []));
  }
  return [];
}
