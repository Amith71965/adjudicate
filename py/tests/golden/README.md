# Phase-2 gold set (25 EB-1A decisions, issued 2025)

Selected by `scripts/select_gold.py` (seed 20261110) from the 38 merits decisions among
50 EB-1A decisions issued in 2025. 2025 only, so it stays disjoint from the 2026
decisions held out for the Phase-7 eval. `texts/` holds the normalised text used for
labelling; `labels/` holds one hand-written label per decision.

## Who labelled, and how
Labelled by the developer (an AI coding assistant working with the repository owner),
**not by an attorney**. Decisions were read from the ANALYSIS section to the ORDER
(the first 7 in full; the rest from verdict-bearing sentences, with the full passage
pulled wherever a verdict was ambiguous). The repository owner blind-checks a random
5. Treat these labels as careful but non-expert, and the extraction scores measured
against them accordingly.

## Fields
- `outcome`: from the ORDER line.
- `criteria`: every criterion the decision *names* as claimed or discussed. Criteria a
  decision says were claimed but never names are not labelled (noted in `notes`).
- `director` ∈ met | not_met | not_addressed — what USCIS (SCOPS) concluded.
- `aao` ∈ met | not_met | not_reached | not_addressed | waived.
- `final_merits` ∈ met | not_met | not_reached | not_addressed — the AAO's conclusion.

## Conventions (applied strictly; the blind check should use the same rules)
- **met / not_met**: the AAO states a conclusion on that criterion, including by
  agreeing with or adopting the Director's finding, or by withdrawing it.
- **not_reached**: the AAO *expressly* declines to decide (reserves; "need not reach";
  "will not disturb … or discuss the individual criteria").
- **not_addressed**: the AAO is silent on a criterion the Director ruled on.
- **waived**: the AAO says the issue was not raised or was abandoned on appeal
  (Matter of O-R-E-, Landers, Garcia). If the AAO says "waived" but *also* concludes
  the criterion is not met, label `not_met`.
- **final_merits = not_reached** when the AAO declines it, even if it adds an advisory
  "we have reviewed the record in the aggregate" remark.

## Known skew
24 dismissed, 1 sustained, **0 remanded** (no 2025 merits decision was a remand), so
remand handling is not tested here; it is covered in the Phase-7 set.
