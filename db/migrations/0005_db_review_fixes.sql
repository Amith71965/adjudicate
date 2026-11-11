-- Fixes from the Phase-2 database review (see _local/INCIDENTS.md).

-- One definition per enumerated vocabulary instead of copies in five CHECKs.
CREATE DOMAIN criterion_code AS text CHECK (VALUE IN (
    'awards', 'membership', 'published_material', 'judging', 'original_contributions',
    'scholarly_articles', 'display', 'leading_role', 'high_salary', 'commercial_success'));
CREATE DOMAIN verdict_code AS text CHECK (VALUE IN (
    'met', 'not_met', 'not_reached', 'not_addressed', 'waived'));
ALTER TABLE criterion_verdict
    DROP CONSTRAINT criterion_verdict_criterion_check,
    DROP CONSTRAINT criterion_verdict_director_check,
    DROP CONSTRAINT criterion_verdict_aao_check,
    ALTER COLUMN criterion TYPE criterion_code,
    ALTER COLUMN director TYPE verdict_code,
    ALTER COLUMN aao TYPE verdict_code;
ALTER TABLE decision_section
    DROP CONSTRAINT decision_section_criterion_check,
    ALTER COLUMN criterion TYPE criterion_code;
ALTER TABLE decision_extraction
    DROP CONSTRAINT decision_extraction_final_merits_check,
    ALTER COLUMN final_merits TYPE verdict_code;

-- Parsed work (and paid LLM extractions) must never vanish by cascade from raw rows;
-- decision ids are stable keys for Phase-3 chunks and Phase-5 citations.
ALTER TABLE decision
    DROP CONSTRAINT decision_raw_decision_id_fkey,
    ADD CONSTRAINT decision_raw_decision_id_fkey
        FOREIGN KEY (raw_decision_id) REFERENCES raw_decision (id) ON DELETE RESTRICT;
ALTER TABLE raw_decision ADD CONSTRAINT raw_decision_decision_id_key UNIQUE (decision_id);

-- The old CHECK passed when byte_size was NULL (NULL = x is NULL, and CHECK accepts NULL).
ALTER TABLE raw_decision
    DROP CONSTRAINT raw_decision_content_complete,
    ADD CONSTRAINT raw_decision_content_complete CHECK (
        content IS NULL
        OR (sha256 IS NOT NULL AND fetched_at IS NOT NULL AND byte_size IS NOT NULL
            AND byte_size = octet_length(content) AND fetch_error IS NULL));
-- PDFs are already compressed: store out of line without pglz (affects new rows).
ALTER TABLE raw_decision ALTER COLUMN content SET STORAGE EXTERNAL;

ALTER TABLE decision ADD CONSTRAINT decision_merits_outcome CHECK (kind <> 'merits' OR outcome IS NOT NULL);

-- Sections carry their own text so Phase 3 can index and chunk without re-slicing.
ALTER TABLE decision_section ADD COLUMN body text;
UPDATE decision_section s
    SET body = substr(d.text, s.start_char + 1, s.end_char - s.start_char)
    FROM decision d WHERE d.id = s.decision_id;
ALTER TABLE decision_section ALTER COLUMN body SET NOT NULL;
ALTER TABLE decision_section
    ADD COLUMN fts tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;
CREATE INDEX decision_section_fts_idx ON decision_section USING gin (fts);

-- Extractions are tied to the parse they read, and retries keep their history.
ALTER TABLE decision_extraction
    ADD COLUMN attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    ADD COLUMN parser_version text;
UPDATE decision_extraction e SET parser_version = d.parser_version
    FROM decision d WHERE d.id = e.decision_id;
ALTER TABLE decision_extraction ALTER COLUMN parser_version SET NOT NULL;

-- Indexes that match the real queries.
DROP INDEX decision_kind_idx;
CREATE INDEX decision_merits_idx ON decision (id) WHERE kind = 'merits';
DROP INDEX raw_decision_sha256_idx;
CREATE INDEX raw_decision_sha256_idx ON raw_decision (sha256) WHERE sha256 IS NOT NULL;
