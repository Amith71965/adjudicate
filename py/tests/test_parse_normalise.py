"""Redaction-artifact and OCR repair. Every input below is copied from a real fixture.

The normaliser repairs *citations* and *redaction residue*; it must never touch
legitimate text (I&N, 214.2(l) for L-1, roman-numeral criteria like (h)(3)(i)).
"""

from __future__ import annotations

import pytest

from adjudicate.parse.normalise import REDACTED, normalise


def n(text: str) -> str:
    return normalise(text).text


class TestRedactionResidue:
    def test_fragment_before_a_redaction_bar(self) -> None:
        assert n("medical degree from thel                       in 2007") == (
            f"medical degree from the {REDACTED} in 2007"
        )

    def test_fragment_with_trailing_glyph_after_the_bar(self) -> None:
        assert n('"[k]nowledge ofl                          lis necessary') == (
            f'"[k]nowledge of {REDACTED} is necessary'
        )

    def test_bang_glyph_after_the_bar(self) -> None:
        assert n("only 80 hours ofl              !training and") == (
            f"only 80 hours of {REDACTED} training and"
        )

    def test_lines_that_are_only_bar_glyphs_are_dropped(self) -> None:
        assert n("worked at\n                    I\nthe hospital") == "worked at\nthe hospital"

    def test_runs_of_bar_glyphs_inside_a_line_collapse(self) -> None:
        assert n("from                  I                      I\nnext") == f"from {REDACTED}\nnext"


class TestCitationRepair:
    @pytest.mark.parametrize(
        ("raw", "fixed"),
        [
            ("section 203(b)(l)(A)(i) of the", "section 203(b)(1)(A)(i) of the"),
            ("Section 203(b )(1 )(A)(i)-(iii)", "Section 203(b)(1)(A)(i)-(iii)"),
            ("Section 203(b )( 1)(A)(i)- (iii)", "Section 203(b)(1)(A)(i)-(iii)"),
            ("203(b)( I )(A)(i) of the", "203(b)(1)(A)(i) of the"),
            ("8 U.S.C. $ 1153(b)(l)(A), as", "8 U.S.C. § 1153(b)(1)(A), as"),
            ("8 U.S.C. fj 1153(b)(l)(A)", "8 U.S.C. § 1153(b)(1)(A)"),
            ("8 U.S .C. § 1153", "8 U.S.C. § 1153"),
            ("8 C.F .R. § 204.5(h)(2)", "8 C.F.R. § 204.5(h)(2)"),
            ("pursuant to 8 C.F.R. § 103 .3.", "pursuant to 8 C.F.R. § 103.3."),
            ("8 C.F.R. § 103.S(a)(l )(iv).", "8 C.F.R. § 103.5(a)(1)(iv)."),
            ("8 C.F.R. § 103.5(a)(l)(ii).", "8 C.F.R. § 103.5(a)(1)(ii)."),
            ("at F.2(B)(l), Criterion 8.", "at F.2(B)(1), Criterion 8."),
            ("Matter of Chawathe, 25 l&N Dec. 369", "Matter of Chawathe, 25 I&N Dec. 369"),
            ("This EB-I classification", "This EB-1 classification"),
        ],
    )
    def test_ocr_damage_is_repaired(self, raw: str, fixed: str) -> None:
        assert n(raw) == fixed

    def test_l1_regulation_letter_is_restored_from_a_misread_digit(self) -> None:
        assert n("8 C.F.R. § 214.2(1)(3)(iv)") == "8 C.F.R. § 214.2(l)(3)(iv)"

    def test_l1_regulation_letter_is_left_alone_and_its_child_repaired(self) -> None:
        assert n("8 C.F.R. § 214.2(l)(l)(ii)(D).") == "8 C.F.R. § 214.2(l)(1)(ii)(D)."

    @pytest.mark.parametrize(
        "clean",
        [
            "Matter of Chawathe, 25 I&N Dec. 369, 375-76 (AAO 2010)",
            "8 C.F.R. § 204.5(h)(3)(i)-(x)",
            "8 C.F.R. § 204.5(h)(3)(viii)",
            "8 C.F.R. § 214.2(o)(3)(iii)(B)",
            "INA section 212(a)(9)(B)(i)(I)",
            "the record contains: (1) the Petitioner's",
            "I agree. I think so.",
        ],
    )
    def test_clean_text_is_untouched(self, clean: str) -> None:
        assert n(clean) == clean


class TestGluedWords:
    @pytest.mark.parametrize(
        ("raw", "fixed"),
        [
            ("at least three ofthe alternate", "at least three of the alternate"),
            ("medical director ofHematology R&D", "medical director of Hematology R&D"),
        ],
    )
    def test_glued_function_words_are_split(self, raw: str, fixed: str) -> None:
        assert n(raw) == fixed

    @pytest.mark.parametrize("word", ["often", "into", "theory", "therefore", "atherosclerosis"])
    def test_real_words_are_not_split(self, word: str) -> None:
        assert n(word) == word


def test_repairs_are_counted_by_rule() -> None:
    result = normalise("from thel        in 2007 and 25 l&N Dec. and 25 l&N Dec.")
    assert result.repairs["redaction_fragment"] == 1
    assert result.repairs["i_and_n"] == 2


def test_normalise_is_idempotent() -> None:
    once = n("8 C.F .R. § 103.S(a)(l )(iv) from thel        in 2007 ofthe")
    assert n(once) == once
