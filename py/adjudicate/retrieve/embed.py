"""Embedders. Production: local BAAI/bge-small-en-v1.5 via fastembed (no key, no billing)."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from fastembed import TextEmbedding

MODEL_NAME = "BAAI/bge-small-en-v1.5"
DIM = 384
CACHE_DIR = Path(__file__).resolve().parents[3] / ".cache" / "fastembed"


class Embedder(Protocol):
    name: str
    dim: int

    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...


class FastEmbedder:
    """bge-small: documents embedded as-is; queries get bge's retrieval instruction prefix."""

    name = MODEL_NAME
    dim = DIM

    def __init__(self, batch_size: int = 32) -> None:
        from fastembed import TextEmbedding  # heavy import, only when actually embedding

        self._model: TextEmbedding = TextEmbedding(MODEL_NAME, cache_dir=str(CACHE_DIR))
        self._batch = batch_size

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [[float(x) for x in v] for v in self._model.embed(texts, batch_size=self._batch)]

    def embed_query(self, text: str) -> list[float]:
        return [float(x) for x in next(iter(self._model.query_embed(text)))]


def vector_literal(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in v) + "]"
