/**
 * Independence: the beneficiary's ego graph. Edges run from the beneficiary to each co-author
 * (publication lists) and to each organization they were affiliated with. A letter author tied
 * by an edge (co-wrote a paper; shares an organization) is not independent; presenting such a
 * letter as independent is a violation. Disclosed ties are reported but are not violations.
 * Names match on surname + first initial (bibliographies print initials) unless full given
 * names clash; accents are folded and particles ("van der") kept. Organizations match after
 * dropping "The", parentheticals and comma parts that only name a campus, office or department.
 */
import type { LetterPacket } from "./types";

export interface Tie {
  kind: "coauthor" | "affiliation" | "same_name";
  via: string; // the publication title, or the beneficiary's organization or name as written
}
export interface LetterTies {
  letter_id: string;
  claimed_independent: boolean;
  ties: Tie[];
  violation: boolean;
}

const HONORIFIC = /^(dr|prof|professor|mr|mrs|ms|mx|sir|dame)$/;
const SUFFIX = /^(jr|sr|ii|iii|iv|phd|md)$/;
const PARTICLE = /^(van|von|der|den|de|del|della|da|di|du|la|le|bin|ibn|al)$/;
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");
const words = (s: string) => fold(s).replace(/[^\p{L}\p{N}'\s-]/gu, " ").split(/\s+/).filter(Boolean);
const plain = (w: string[]) => w.filter((t) => !HONORIFIC.test(t.toLowerCase()) && !SUFFIX.test(t.toLowerCase()));

/** A printed name as surname + given names (full names or initials). */
function parseName(name: string): { surname: string; given: string[] } {
  if (name.includes(",")) {
    const [left, ...rest] = name.split(",");
    return { surname: plain(words(left)).join(" ").toLowerCase(), given: plain(words(rest.join(" "))).map((t) => t.toLowerCase()) };
  }
  const t = plain(words(name));
  if (t.length === 0) return { surname: "", given: [] };
  const last = t[t.length - 1];
  if (t.length >= 2 && /^\p{Lu}{1,3}$/u.test(last)) {
    // bibliography style without a comma: "Smith J", "Okafor-Lind TA"
    return { surname: t.slice(0, -1).join(" ").toLowerCase(), given: [...last.toLowerCase()] };
  }
  let start = t.length - 1;
  for (let i = 1; i < t.length - 1; i++) {
    if (PARTICLE.test(t[i].toLowerCase())) { start = i; break; }
  }
  return { surname: t.slice(start).join(" ").toLowerCase(), given: t.slice(0, start).map((x) => x.toLowerCase()) };
}

/** Surname + first initial; "" when either is missing, so an empty key never matches. */
export function nameKey(name: string): string {
  const { surname, given } = parseName(name);
  const initial = given[0]?.charAt(0) ?? "";
  return surname && initial ? `${surname}|${initial}` : "";
}

/** Same surname and initial, and no clash between full given names ("Wei Li" is not "Wen Li"). */
export function namesAgree(a: string, b: string): boolean {
  const ka = nameKey(a);
  if (!ka || ka !== nameKey(b)) return false;
  const ga = parseName(a).given[0];
  const gb = parseName(b).given[0];
  return ga.length < 2 || gb.length < 2 || ga === gb;
}

// Comma-separated parts that only locate a unit within an organization.
const QUALIFIER = /\b(campus|office|branch|headquarters|hq|department|dept|division|faculty|school)\b/;

/** Normalized organization; "" when nothing is left, so an empty key never matches. */
export function orgKey(org: string): string {
  const parts = fold(org).toLowerCase().replace(/\([^)]*\)/g, " ").split(",").map((p) => p.trim()).filter(Boolean);
  const kept = parts.length > 1 ? parts.filter((p) => !QUALIFIER.test(p)) : parts;
  return (kept.length ? kept : parts.slice(0, 1)).join(" ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/^the /, "");
}

export function independenceTies(packet: LetterPacket): LetterTies[] {
  const self = packet.beneficiary.name;
  const orgs = new Map(packet.beneficiary.affiliations.map((o) => [orgKey(o), o] as const).filter(([k]) => k !== ""));
  return packet.letters.map((letter) => {
    const ties: Tie[] = [];
    if (namesAgree(letter.author.name, self)) {
      // cannot tell the beneficiary's papers from the author's: flag for the attorney, never skip
      ties.push({ kind: "same_name", via: self });
    } else {
      for (const pub of packet.beneficiary.publications) {
        if (pub.authors.some((a) => namesAgree(a, letter.author.name))) ties.push({ kind: "coauthor", via: pub.title });
      }
    }
    for (const affiliation of letter.author.affiliations) {
      const key = orgKey(affiliation);
      const match = key ? orgs.get(key) : undefined;
      if (match !== undefined && !ties.some((t) => t.kind === "affiliation" && t.via === match)) {
        ties.push({ kind: "affiliation", via: match });
      }
    }
    return {
      letter_id: letter.id,
      claimed_independent: letter.author.claimed_independent,
      ties,
      violation: letter.author.claimed_independent && ties.length > 0,
    };
  });
}
