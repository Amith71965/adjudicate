"""Split reasoning sections into overlapping word windows with exact character offsets.

Chunks never cross a section boundary, so every retrieved passage belongs to exactly
one criterion / final-merits / reserved-issues section and can be cited precisely.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Preamble and LAW restate the same statute in every decision; indexing them would make
# every decision look relevant to every query.
CHUNKABLE_KINDS = frozenset({"analysis", "criterion", "final_merits", "reserved", "other"})
MAX_WORDS = 220
OVERLAP = 40
_WORD = re.compile(r"\S+")


@dataclass(frozen=True, slots=True)
class Chunk:
    start_char: int  # absolute offset into decision.text
    end_char: int
    body: str


def chunk_section(
    body: str, *, section_start: int, max_words: int = MAX_WORDS, overlap: int = OVERLAP
) -> list[Chunk]:
    if not 0 <= overlap < max_words:
        raise ValueError(f"overlap {overlap} must be >= 0 and smaller than max_words {max_words}")
    words = list(_WORD.finditer(body))
    chunks: list[Chunk] = []
    step = max_words - overlap
    i = 0
    while i < len(words):
        window = words[i : i + max_words]
        start, end = window[0].start(), window[-1].end()
        chunks.append(Chunk(section_start + start, section_start + end, body[start:end]))
        if i + max_words >= len(words):
            break
        i += step
    return chunks
