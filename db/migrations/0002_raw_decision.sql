-- Raw AAO decisions as harvested: one row per canonical URL, bytes kept verbatim.
CREATE TABLE raw_decision (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    url            text        NOT NULL UNIQUE,              -- canonical https://www.uscis.gov/... form
    decision_id    text        NOT NULL,                     -- e.g. SEP152026_01B2203
    category       text        NOT NULL,                     -- AAO folder name, e.g. "B2 - Aliens with ..."
    visa_type      text        NOT NULL
        CHECK (visa_type IN ('EB-1A', 'O-1', 'EB-2/NIW', 'EB-1C', 'L-1', 'EB-1B', 'other')),
    listing_topic  smallint,                                 -- uri_1 filter it was discovered under
    issued_year    smallint,                                 -- from Decisions_Issued_in_YYYY
    display_date   date,                                     -- date shown in the index
    decision_date  date,                                     -- from the MMMDDYYYY filename prefix
    discovered_at  timestamptz NOT NULL DEFAULT now(),
    fetched_at     timestamptz,
    http_status    smallint,
    content_type   text,
    byte_size      integer,
    sha256         text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content        bytea,                                    -- the PDF, verbatim
    fetch_error    text,                                     -- last failure; NULL once fetched
    CONSTRAINT raw_decision_content_complete CHECK (
        content IS NULL
        OR (sha256 IS NOT NULL AND fetched_at IS NOT NULL
            AND byte_size = octet_length(content) AND fetch_error IS NULL)
    )
);

CREATE INDEX raw_decision_pending_idx ON raw_decision (listing_topic, issued_year)
    WHERE content IS NULL;
CREATE INDEX raw_decision_sha256_idx ON raw_decision (sha256);
CREATE INDEX raw_decision_visa_date_idx ON raw_decision (visa_type, decision_date);

-- One row per harvester invocation: the audit trail for "re-run adds nothing".
CREATE TABLE harvest_run (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    topic           smallint    NOT NULL,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    pages_walked    integer     NOT NULL DEFAULT 0,
    discovered_new  integer     NOT NULL DEFAULT 0,
    fetched         integer     NOT NULL DEFAULT 0,
    failed          integer     NOT NULL DEFAULT 0,
    error           text
);
