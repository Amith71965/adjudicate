"""PDF bytes → layout-preserving text via poppler's ``pdftotext`` (host dependency)."""

from __future__ import annotations

import subprocess


class PdfTextError(RuntimeError):
    """The bytes are not a PDF, or the PDF has no extractable text layer."""


def pdf_to_text(data: bytes, *, timeout: float = 60.0) -> str:
    if not data.startswith(b"%PDF-"):
        raise PdfTextError("not a PDF (missing %PDF- header)")
    try:
        result = subprocess.run(
            ["pdftotext", "-layout", "-q", "-", "-"],  # noqa: S607 — poppler on PATH
            input=data,
            capture_output=True,
            check=True,
            timeout=timeout,
        )
    except subprocess.CalledProcessError as exc:
        raise PdfTextError(f"no readable text layer (pdftotext exit {exc.returncode})") from exc
    except subprocess.TimeoutExpired as exc:
        raise PdfTextError(f"pdftotext timed out after {timeout}s") from exc
    text = result.stdout.decode("utf-8", errors="replace")
    if not text.strip():
        raise PdfTextError("PDF has no text layer")
    return text
