-- Structured corpus derived from raw_decision (Phase 2). Every row traces to its raw PDF.

CREATE TABLE decision (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    raw_decision_id  bigint      NOT NULL UNIQUE REFERENCES raw_decision (id) ON DELETE CASCADE,
    parser_version   text        NOT NULL,
    kind             text        NOT NULL CHECK (kind IN (
                         'merits', 'motion', 'legacy_format', 'unstructured', 'out_of_scope',
                         'no_analysis', 'no_criterion_analysis', 'too_short', 'unreadable')),
    kind_reason      text        NOT NULL,           -- why the filter accepted/rejected it
    words            integer     NOT NULL DEFAULT 0 CHECK (words >= 0),
    outcome          text CHECK (outcome IN (
                         'dismissed', 'sustained', 'remanded', 'rejected',
                         'motion_dismissed', 'motion_granted', 'unknown')),
    text             text,                            -- normalised (redaction/OCR-repaired)
    repairs          jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- normaliser repair counts
    parsed_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT decision_text_iff_readable CHECK ((kind = 'unreadable') = (text IS NULL))
);
CREATE INDEX decision_kind_idx ON decision (kind);

-- Reasoning spans: offsets into decision.text (Phase-3 chunking unit).
CREATE TABLE decision_section (
    decision_id  bigint   NOT NULL REFERENCES decision (id) ON DELETE CASCADE,
    ordinal      smallint NOT NULL CHECK (ordinal >= 0),
    kind         text     NOT NULL CHECK (kind IN (
                     'preamble', 'law', 'analysis', 'criterion', 'final_merits',
                     'reserved', 'conclusion', 'other')),
    title        text     NOT NULL,
    criterion    text CHECK (criterion IN (
                     'awards', 'membership', 'published_material', 'judging',
                     'original_contributions', 'scholarly_articles', 'display',
                     'leading_role', 'high_salary', 'commercial_success')),
    start_char   integer  NOT NULL CHECK (start_char >= 0),
    end_char     integer  NOT NULL,
    PRIMARY KEY (decision_id, ordinal),
    CONSTRAINT decision_section_span CHECK (end_char > start_char),
    CONSTRAINT decision_section_criterion_iff_kind CHECK ((kind = 'criterion') = (criterion IS NOT NULL))
);

CREATE TABLE decision_citation (
    decision_id  bigint NOT NULL REFERENCES decision (id) ON DELETE CASCADE,
    reporter     text   NOT NULL,                  -- e.g. '596 F.3d 1115', '25 I&N Dec. 369'
    name         text   NOT NULL,
    PRIMARY KEY (decision_id, reporter)
);
CREATE INDEX decision_citation_reporter_idx ON decision_citation (reporter);

-- One LLM extraction attempt per decision; error rows keep failures visible.
CREATE TABLE decision_extraction (
    decision_id   bigint        PRIMARY KEY REFERENCES decision (id) ON DELETE CASCADE,
    model         text          NOT NULL,
    final_merits  text CHECK (final_merits IN ('met', 'not_met', 'not_reached', 'not_addressed', 'waived')),
    cost_usd      numeric(10,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
    error         text,
    extracted_at  timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT decision_extraction_result_xor_error CHECK ((error IS NULL) = (final_merits IS NOT NULL))
);

CREATE TABLE criterion_verdict (
    decision_id   bigint NOT NULL REFERENCES decision_extraction (decision_id) ON DELETE CASCADE,
    criterion     text   NOT NULL CHECK (criterion IN (
                      'awards', 'membership', 'published_material', 'judging',
                      'original_contributions', 'scholarly_articles', 'display',
                      'leading_role', 'high_salary', 'commercial_success')),
    director      text   NOT NULL CHECK (director IN ('met', 'not_met', 'not_reached', 'not_addressed', 'waived')),
    aao           text   NOT NULL CHECK (aao IN ('met', 'not_met', 'not_reached', 'not_addressed', 'waived')),
    failed_prong  text,
    quote         text   NOT NULL,                  -- verbatim from decision.text (grounding gate)
    PRIMARY KEY (decision_id, criterion)
);
CREATE INDEX criterion_verdict_aao_idx ON criterion_verdict (criterion, aao);
