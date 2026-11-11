"""The fixture PII guard must scan every file it can read and refuse what it can't."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from adjudicate.hygiene import UnscannableFileError, scan_for_pii, scan_tree


def test_canary_pii_in_an_unusual_text_suffix_is_caught(tmp_path: Path) -> None:
    (tmp_path / "petition.YAML").write_text("applicant_ssn: 123-45-6789\n")
    findings = scan_tree([tmp_path])
    assert [(f.path.name, f.kind) for f in findings] == [("petition.YAML", "ssn")]


def test_suffixless_file_is_scanned(tmp_path: Path) -> None:
    (tmp_path / "NOTES").write_text("reach me at someone@example.org")
    assert {f.kind for f in scan_tree([tmp_path])} == {"email"}


def test_pdf_text_layer_is_scanned(tmp_path: Path) -> None:
    pdf = tmp_path / "letter.pdf"
    _make_pdf(pdf, "Beneficiary A-123-456-789")
    assert {f.kind for f in scan_tree([tmp_path])} == {"a_number"}


def test_pdf_without_text_layer_is_refused(tmp_path: Path) -> None:
    (tmp_path / "scan.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
    with pytest.raises(UnscannableFileError, match=r"scan\.pdf"):
        scan_tree([tmp_path])


def test_unknown_binary_is_refused_not_skipped(tmp_path: Path) -> None:
    (tmp_path / "blob.docx").write_bytes(b"PK\x03\x04\x00\xff\xfe binary")
    with pytest.raises(UnscannableFileError, match=r"blob\.docx"):
        scan_tree([tmp_path])


def test_missing_root_is_an_error_not_a_vacuous_pass(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        scan_tree([tmp_path / "does-not-exist"])


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("ssn 123 45 6789", "ssn"),
        ("ssn 123456789 on intake", "ssn_bare"),
        ("a123456789", "a_number"),
        ("call (415) 555-0134", "phone"),
        ("DOB: 03/14/1988", "dob"),
    ],
)
def test_scanner_covers_common_variants(text: str, kind: str) -> None:
    assert kind in {f.kind for f in scan_for_pii(text)}


def test_decision_receipt_numbers_are_not_ssns() -> None:
    # AAO headers carry an 8-digit "In Re:" number; it must not trip ssn_bare.
    assert scan_for_pii("In Re: 44003330") == []


def _make_pdf(path: Path, text: str) -> None:
    """Minimal single-page PDF with a real text layer (no external deps)."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    path.write_bytes(bytes(out))
    # Sanity: the fixture itself must be extractable, or the test proves nothing.
    assert (
        text
        in subprocess.run(
            ["pdftotext", str(path), "-"], capture_output=True, text=True, check=True
        ).stdout
    )


def test_committed_eval_data_contains_no_pii() -> None:
    # Synthetic petitions and eval results are committed; they must stay clean.
    root = Path(__file__).resolve().parents[2] / "eval"
    assert scan_tree([root]) == []
