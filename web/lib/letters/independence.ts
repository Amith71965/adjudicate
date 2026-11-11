/**
 * Independence: the beneficiary's ego graph. Edges run from the beneficiary to each co-author
 * (publication lists) and to each organization they were affiliated with. A letter author tied
 * by an edge (co-wrote a paper; shares an organization) is not independent; presenting such a
 * letter as independent is a violation. Disclosed ties are reported but are not violations.
 * Names match on surname + first initial (bibliographies print initials); organizations match
 * after dropping "The", parentheticals and trailing ", location" qualifiers.
 */
import type { LetterPacket } from "./types";

export interface Tie {
  kind: "coauthor" | "affiliation";
  via: string; // the publication title, or the beneficiary's organization as written
}
export interface LetterTies {
  letter_id: string;
  claimed_independent: boolean;
  ties: Tie[];
  violation: boolean;
}

const HONORIFIC = /^(dr|prof|professor|mr|mrs|ms|mx)\.?$/i;

export function nameKey(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.includes(",")) {
    const [surname, rest] = clean.split(",", 2);
    return `${surname.trim().toLowerCase()}|${rest.trim().charAt(0).toLowerCase()}`;
  }
  const tokens = clean.split(" ").filter((t) => !HONORIFIC.test(t));
  const surname = tokens[tokens.length - 1] ?? "";
  return `${surname.replace(/[.,]$/, "").toLowerCase()}|${(tokens[0] ?? "").charAt(0).toLowerCase()}`;
}

export function orgKey(org: string): string {
  return org
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(",")[0]
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");
}

export function independenceTies(packet: LetterPacket): LetterTies[] {
  const self = nameKey(packet.beneficiary.name);
  const orgs = new Map(packet.beneficiary.affiliations.map((o) => [orgKey(o), o]));
  return packet.letters.map((letter) => {
    const who = nameKey(letter.author.name);
    const ties: Tie[] = [];
    if (who !== self) {
      for (const pub of packet.beneficiary.publications) {
        if (pub.authors.some((a) => nameKey(a) === who)) ties.push({ kind: "coauthor", via: pub.title });
      }
    }
    for (const affiliation of letter.author.affiliations) {
      const match = orgs.get(orgKey(affiliation));
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
