/**
 * Two-part EB-1A criteria: each half is an independent test, and failing either fails the
 * criterion (failure mode B). Conservative reading of 8 C.F.R. § 204.5(h)(3); mirrors
 * `Criterion.two_part` on the Python side.
 */
export interface Prong {
  id: string;
  test: string;
}

export const PRONGS: Record<string, Prong[]> = {
  leading_role: [
    { id: "role", test: "the beneficiary performed a leading or critical role for the organization or a division of it" },
    { id: "reputation", test: "the organization or establishment has a distinguished reputation" },
  ],
  published_material: [
    { id: "about", test: "the material is about the beneficiary and their work, not merely mentioning or citing it" },
    { id: "venue", test: "it appeared in professional or major trade publications or other major media" },
  ],
  membership: [
    { id: "requirement", test: "the association requires outstanding achievements of its members" },
    { id: "judged", test: "those achievements are judged by recognized national or international experts" },
  ],
  original_contributions: [
    { id: "original", test: "the contributions are original to the beneficiary" },
    { id: "significance", test: "they are of major significance to the field as a whole" },
  ],
};

export function prongsFor(criterion: string): Prong[] {
  return PRONGS[criterion] ?? [{ id: "whole", test: `the evidence satisfies the ${criterion} criterion` }];
}
