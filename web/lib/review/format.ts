/** Display helpers shared by the review UI. */
import type { ReviewItem } from "./cases";

export const label = (code: string) => code.replace(/_/g, " ");
export const pct = (p: number) => Math.round(p * 100);

/** A fragment id for an item, usable in an href without escaping. */
export const itemAnchor = (itemId: string) => `item-${itemId.replace(/[^a-z0-9]+/g, "-")}`;

/** "judging / whole", "high salary waiver check", from an item or an item id. */
export function itemTitle(item: ReviewItem | string): string {
  const id = typeof item === "string" ? item : item.id;
  const [kind, rest = ""] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  if (kind === "waiver") {
    const criterion = rest.slice(rest.indexOf(":") + 1);
    return `${label(criterion)} waiver check`;
  }
  const [criterion, prong] = rest.split("/");
  return `${label(criterion)} / ${prong}`;
}

export const citeHref = (caseId: string, itemId: string, n: number) =>
  `/cases/${caseId}?${new URLSearchParams({ item: itemId, cite: String(n) })}#passage`;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "AUG172026_02B2203" → "17 Aug 2026": USCIS encodes the issue date in the decision id. */
export function decisionDate(decisionId: string): string {
  const m = /^([A-Z]{3})(\d{2})(\d{4})_/.exec(decisionId);
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (!m || month < 0) return "";
  return `${Number(m[2])} ${m[1][0]}${m[1].slice(1).toLowerCase()} ${m[3]}`;
}
