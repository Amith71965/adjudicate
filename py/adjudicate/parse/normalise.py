"""Repair redaction residue and OCR damage in AAO decision text.

AAO PDFs are redacted (names of people, employers, journals blacked out) and
then OCR'd. The redaction bars leave glyph fragments ("thel", lone "I" lines,
"!"), and OCR damages legal citations ("203(b)(l)(A)", "8 C.F .R.", "l&N").

Rules are deliberately *scoped*: citation repairs only run inside citation
chains, so legitimate text — "I&N", the L-1 regulation "214.2(l)", roman
numeral criteria "(h)(3)(i)", subclause "(i)(I)" — is never rewritten. Every
rule counts its repairs so drift in the source can be measured, not guessed.

Accepted risk (documented in _local/INCIDENTS.md): a lower-case "l" glued to
the word right after a redaction bar is treated as a bar glyph, so a real word
starting with "l" directly after a redaction ("ofl   living") would lose it.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

REDACTED = "[REDACTED]"

_GLYPH = r"[Il|!]"
_BAR_ONLY_LINE = re.compile(rf"^[ \t]*{_GLYPH}(?:[ \t]+{_GLYPH})*[ \t]*\n", re.MULTILINE)
_FUNCTION_WORDS = (
    "the|of|from|at|in|on|by|with|and|for|to|an|a|his|her|their|its"
    "|how|about|regarding|that|as|whether"
)
# "thel<gap>" / "ofl<gap>!word": a function word fused with the bar's left edge,
# optionally followed by a glyph fused to the next word.
_FRAGMENT = re.compile(
    rf"\b({_FUNCTION_WORDS})l(?:[ \t]{{3,}}(?:[l|!](?=[a-z]))?|[ \t]*$)", re.MULTILINE
)
# "its~<gap>" / "third-party!<gap>": a bar glyph fused to the END of a real word.
_FUSED_TAIL = re.compile(r"(\w)[~!][ \t]{3,}(?:l(?=[a-z]))?")
# "[REDACTED] I" at end of line: the bar's right-edge glyph left behind.
_TRAILING_GLYPHS = re.compile(rf"(\[REDACTED\])(?:[ \t]+{_GLYPH})+[ \t]*$", re.MULTILINE)
_GLYPH_RUN_EOL = re.compile(rf"(\S)[ \t]{{3,}}{_GLYPH}(?:[ \t]+{_GLYPH})*[ \t]*$", re.MULTILINE)
_GLYPH_RUN_MID = re.compile(rf"[ \t]{{3,}}{_GLYPH}(?:[ \t]{{3,}}{_GLYPH})*[ \t]{{3,}}")
_SPACES = re.compile(r"[ \t]{2,}")
_LINE_EDGES = re.compile(r"^[ \t]+|[ \t]+$", re.MULTILINE)

# Roman-numeral section headings damaged by OCR: "TI. ANALYSIS", "II. ANALYSrS".
_HEADING = re.compile(r"^([IVXTl1]{1,4})\. ([A-Z][A-Za-z0-9 ]{1,40})$", re.MULTILINE)
_ANALYSIS_TITLE = re.compile(r"^ANALYS[^I\s]S$")


def _fix_heading(match: re.Match[str]) -> str:
    numeral = match.group(1).translate(str.maketrans("Tl1", "III"))
    title = match.group(2)
    if _ANALYSIS_TITLE.match(title):
        title = "ANALYSIS"
    if not title.replace(" ", "").isupper():
        return match.group(0)  # not a section heading (e.g. "A. The Petitioner")
    return f"{numeral}. {title}"


_CFR = re.compile(r"\bC\s?\.\s?F\s?\.\s?R\s?\.")
_USC = re.compile(r"\bU\s?\.\s?S\s?\.\s?C\s?\.")
_SECTION_SIGN = re.compile(r"(U\.S\.C\.|C\.F\.R\.) ?(?:\$|fj|§) ?(?=\d)")
_SECTION_DOT = re.compile(r"(§ \d+) \.(\d)")
_SECTION_S5 = re.compile(r"(§ \d+\.)S(?=\()")
# A citation chain: a section number followed by one or more (x) groups, allowing
# OCR spaces inside/between parens and "-" ranges: 203(b )( l)(A)(i)- (iii)
_CHAIN = re.compile(r"\d+(?:\.\w+)?(?:\s?-?\s?\(\s?[0-9A-Za-z]{1,5}\s?\))+")
_PAREN = re.compile(r"\(\s?([0-9A-Za-z]{1,5})\s?\)")
_ROMAN_LOWER = frozenset("ivx")
_I_AND_N = re.compile(r"\b(\d+ )[lT]&N\b")
# "Matter ofO-R-E-", "Matter afChawathe", "Matter a/Christa's": OCR-damaged "of".
_MATTER_OF = re.compile(r"\bMatter (?:of|af|a/|o/)(?=[A-Z])")
_EB1 = re.compile(r"\bEB-[Il]\b")
_GLUED_THE = re.compile(r"\b(of|in|to|and|on|for|at|by|from)the\b")
_GLUED_CAP = re.compile(r"\b(of|in|to|and|for|at|by|from|with)([A-Z][a-z]{2,})")


@dataclass(frozen=True, slots=True)
class Normalised:
    text: str
    repairs: Counter[str] = field(default_factory=Counter)


def _fix_chain(match: re.Match[str]) -> str:
    chain = match.group(0)
    head = chain[: chain.index("(")].rstrip(" -")
    parts = _PAREN.findall(chain)
    separators = re.findall(r"\)\s?(-?)\s?\(", chain)
    fixed: list[str] = []
    for i, part in enumerate(parts):
        if i == 0 and head == "214.2" and part == "1":
            part = "l"  # 8 CFR 214.2 top-level paragraphs are letters; L-1 is (l)
        elif i > 0 and part == "l":
            part = "1"  # "l" is never a valid sub-paragraph after another paragraph
        elif (
            i > 0
            and part == "I"
            and len(prev := fixed[-1]) == 1
            and prev.islower()
            and prev not in _ROMAN_LOWER
        ):
            part = "1"  # after a lettered paragraph like (b) comes a number, not (I)
        fixed.append(part)
    out = head + f"({fixed[0]})"
    for sep, part in zip(separators, fixed[1:], strict=True):
        out += f"{sep}({part})"
    return out


def normalise(text: str) -> Normalised:
    repairs: Counter[str] = Counter()

    def sub(name: str, pattern: re.Pattern[str], repl: str, s: str) -> str:
        new, count = pattern.subn(repl, s)
        if count:
            repairs[name] += count
        return new

    t = text.replace("\f", "\n")  # pdftotext page breaks; headings may start a page
    t = sub("bar_glyph_line", _BAR_ONLY_LINE, "", t)
    t = sub("redaction_fragment", _FRAGMENT, rf"\1 {REDACTED} ", t)
    t = sub("redaction_fragment", _FUSED_TAIL, rf"\1 {REDACTED} ", t)
    t = sub("bar_glyph_run", _GLYPH_RUN_EOL, rf"\1 {REDACTED}", t)
    t = sub("bar_glyph_run", _GLYPH_RUN_MID, f" {REDACTED} ", t)
    t = sub("bar_glyph_run", _TRAILING_GLYPHS, r"\1", t)
    t = _SPACES.sub(" ", t)
    t = _LINE_EDGES.sub("", t)

    headed = _HEADING.sub(_fix_heading, t)
    if headed != t:
        repairs["section_heading"] += sum(
            a != b for a, b in zip(t.splitlines(), headed.splitlines(), strict=True)
        )
    t = headed
    t = sub("cfr_spacing", _CFR, "C.F.R.", t)
    t = sub("cfr_spacing", _USC, "U.S.C.", t)
    t = sub("section_sign", _SECTION_SIGN, r"\1 § ", t)
    t = sub("section_number", _SECTION_DOT, r"\1.\2", t)
    t = sub("section_number", _SECTION_S5, r"\g<1>5", t)
    fixed_chains = _CHAIN.sub(_fix_chain, t)
    if fixed_chains != t:
        repairs["citation_chain"] += (
            sum(
                a != b
                for a, b in zip(_CHAIN.findall(t), _CHAIN.findall(fixed_chains), strict=False)
            )
            or 1
        )
    t = fixed_chains
    t = sub("i_and_n", _I_AND_N, r"\1I&N", t)
    t = sub("matter_of", _MATTER_OF, "Matter of ", t)
    t = sub("eb1", _EB1, "EB-1", t)
    t = sub("glued_word", _GLUED_THE, r"\1 the", t)
    t = sub("glued_word", _GLUED_CAP, r"\1 \2", t)
    return Normalised(t, repairs)
