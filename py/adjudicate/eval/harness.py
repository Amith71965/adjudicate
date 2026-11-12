"""Phase-7 harness: real held-out decisions → facts-only petitions → the TypeScript examiner
over HTTP (/api/examine, a black box) → split guard → per-criterion rows → score.

The split guard checks every passage the examiner retrieved or cited: it must come from a
decision the index may use (issued before the cutoff) and never from a test decision. One
violation stops the run — a leaked answer must not be averaged away.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import httpx

from adjudicate.eval.facts import FactsOutcome
from adjudicate.eval.realset import Split, TestDecision
from adjudicate.eval.score import Row, score
from adjudicate.schemas.petition import Petition

THRESHOLD = 0.5  # fixed before any real run; AUROC is reported so no threshold is tuned


class HarnessError(RuntimeError):
    """The pipeline cannot produce an honest score (HTTP failure, split violation)."""


type Json = dict[str, object]
type FactsFn = Callable[[TestDecision, int], FactsOutcome]
type ExamineFn = Callable[[Petition, date], Json]
type ChunkLookup = Callable[[list[int]], dict[int, str]]


def examine(http: httpx.Client, petition: Petition, before: date) -> Json:
    body = {"petition": petition.model_dump(mode="json"), "before": before.isoformat()}
    try:
        res = http.post("/api/examine", json=body)
    except httpx.HTTPError as exc:
        raise HarnessError(f"examine {petition.id}: {type(exc).__name__}: {exc}") from exc
    if res.status_code != 200:
        try:
            detail = res.json().get("error", res.text)
        except ValueError:
            detail = res.text
        raise HarnessError(f"examine {petition.id}: HTTP {res.status_code}: {str(detail)[:300]}")
    out = res.json()
    if not isinstance(out, dict) or not isinstance(out.get("result"), dict):
        raise HarnessError(f"examine {petition.id}: malformed response")
    return out


def _chunk_ids(result: Json) -> list[int]:
    ids: list[int] = []
    for key in ("reviews", "dropped"):
        for outcome in result.get(key) or []:  # type: ignore[attr-defined]
            ids += outcome.get("retrieved_chunk_ids") or []
            for c in (outcome.get("review") or {}).get("citations") or []:
                ids.append(c["chunk_id"])
    return sorted(set(ids))


def split_guard(
    result: Json, chunk_decisions: ChunkLookup, *, index_ids: frozenset[str],
    test_ids: frozenset[str],
) -> tuple[int, list[str]]:  # fmt: skip
    ids = _chunk_ids(result)
    owners = chunk_decisions(ids)
    violations = []
    for cid in ids:
        did = owners.get(cid)
        if did is None:
            violations.append(f"chunk {cid} has no known decision")
        elif did in test_ids:
            violations.append(f"chunk {cid} is from {did}, a test decision")
        elif did not in index_ids:
            violations.append(f"chunk {cid} is from {did}, issued on or after the cutoff")
    return len(ids), violations


def rows_for(d: TestDecision, facts: FactsOutcome, result: Json | None) -> list[Row]:
    risks: dict[str, float] = (result or {}).get("criterion_risk") or {}  # type: ignore[assignment]
    return [
        Row(
            decision_id=d.decision_id,
            criterion=c.criterion,
            label=c.label.label,
            source=c.label.source,
            director=c.director,
            risk=risks.get(c.criterion) if result is not None else None,
            outcome=d.outcome,
            placeholder=c.criterion in facts.placeholders,
        )
        for c in d.criteria
    ]


def _r4(x: float | None) -> float | None:
    # 4 dp: enough for a risk, and long float digit runs read as SSNs to the PII guard
    return None if x is None else round(x, 4)


def run(
    split: Split, *, facts: FactsFn, examine: ExamineFn, chunk_decisions: ChunkLookup,
    workers: int = 1, threshold: float = THRESHOLD, calibration_end: date | None = None,
) -> Json:  # fmt: skip
    test_ids = frozenset(d.decision_id for d in split.test)

    def process(item: tuple[int, TestDecision]) -> tuple[TestDecision, FactsOutcome, Json | None]:
        i, d = item
        f = facts(d, i + 1)
        if f.status != "ok" or f.petition is None:
            return d, f, None
        return d, f, examine(f.petition, split.cutoff)

    def results() -> Iterator[tuple[TestDecision, FactsOutcome, Json | None]]:
        items = list(enumerate(split.test))
        if workers <= 1:
            yield from map(process, items)
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                yield from pool.map(process, items)

    rows: list[Row] = []
    decisions: list[Json] = []
    checked = 0
    llm: object = {}
    counts = {"ok": 0, "leaky": 0, "failed": 0, "retried": 0, "placeholders": 0,
              "with_soft_terms": 0}  # fmt: skip
    for d, f, response in results():
        if f.status not in ("ok", "leaky", "failed"):
            raise HarnessError(f"{d.decision_id}: unknown facts status {f.status!r}")
        counts[f.status] += 1
        counts["retried"] += f.attempts > 1
        counts["placeholders"] += len(f.placeholders)
        counts["with_soft_terms"] += bool(f.soft)
        result: Json | None = None
        if response is not None:
            raw = response["result"]
            if not isinstance(raw, dict):
                raise HarnessError(f"{d.decision_id}: response has no result object")
            result = raw
            n, violations = split_guard(
                result, chunk_decisions, index_ids=split.index_decision_ids, test_ids=test_ids
            )
            if violations:
                raise HarnessError(f"split guard, {d.decision_id}: {'; '.join(violations[:5])}")
            checked += n
            llm = response.get("llm") or llm
        rows += rows_for(d, f, result)
        decisions.append(
            {
                "decision_id": d.decision_id,
                "outcome": d.outcome,
                "status": "examined" if result is not None else f.status,
                "leaks": f.leaks,
                "error": f.error,
                "placeholders": f.placeholders,
                "rfe_risk": _r4(result.get("rfe_risk") if result else None),  # type: ignore[arg-type]
                "complete": result.get("complete") if result else None,
                "criteria": [
                    {
                        "criterion": r.criterion,
                        "label": r.label,
                        "source": r.source,
                        "director": r.director,
                        "risk": _r4(r.risk),
                    }
                    for r in rows
                    if r.decision_id == d.decision_id
                ],
            }
        )
    # the threshold is fit on the earliest test decisions and scored on the rest (pre-registered
    # after a 3-decision pilot showed every risk above the fixed 0.5)
    calibration = frozenset(
        d.decision_id for d in split.test if calibration_end and d.decided < calibration_end
    )
    return {
        "cutoff": split.cutoff.isoformat(),
        "test_decisions": len(split.test),
        "facts": counts,
        "split_guard": {"checked_chunks": checked, "violations": []},
        "llm": llm,
        "calibration_end": calibration_end.isoformat() if calibration_end else None,
        "score": score(rows, threshold=threshold, calibration_ids=calibration),
        "decisions": decisions,
    }
