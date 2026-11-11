-- Per-row retry accounting and per-run completeness, from the phase-1 silent-failure review.
ALTER TABLE raw_decision
    ADD COLUMN fetch_attempts  integer     NOT NULL DEFAULT 0 CHECK (fetch_attempts >= 0),
    ADD COLUMN last_attempt_at timestamptz;

ALTER TABLE harvest_run
    ADD COLUMN total_listed integer,                    -- "of N total rows" on page 0
    ADD COLUMN reached_end  boolean,                    -- false = stopped by --max-pages
    ADD COLUMN abandoned    integer NOT NULL DEFAULT 0, -- rows past the retry cap
    ADD COLUMN warnings     integer NOT NULL DEFAULT 0; -- drift / unexpected-category notices

DROP INDEX raw_decision_pending_idx;
CREATE INDEX raw_decision_pending_idx ON raw_decision (listing_topic, fetch_attempts, issued_year)
    WHERE content IS NULL;
