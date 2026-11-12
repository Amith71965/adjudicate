-- Phase 8: the attorney's review log. One immutable row per disposition of an AI objection
-- (resolve / dismiss / reopen), per sign-off and per export. The log is the case's version
-- history, so the database refuses UPDATE, DELETE and TRUNCATE outright.
CREATE TABLE review_event (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id     text        NOT NULL CHECK (case_id ~ '^P[0-9]{2,4}$'),
    item_id     text        CHECK (item_id ~ '^[a-z]+:[a-z0-9_/:-]{1,80}$'),
    action      text        NOT NULL CHECK (action IN ('resolve', 'dismiss', 'reopen', 'signoff', 'export')),
    note        text        NOT NULL CHECK (length(btrim(note)) >= 3 AND length(note) <= 2000),
    actor       text        NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 80),
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- dispositions name the objection; sign-off and export are for the whole case
    CONSTRAINT review_event_item_scope CHECK (
        (action IN ('resolve', 'dismiss', 'reopen')) = (item_id IS NOT NULL))
);
CREATE INDEX review_event_case_idx ON review_event (case_id, id);

CREATE FUNCTION review_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'review_event is append-only (% refused)', TG_OP;
END $$;
CREATE TRIGGER review_event_no_update_delete
    BEFORE UPDATE OR DELETE ON review_event
    FOR EACH ROW EXECUTE FUNCTION review_event_append_only();
CREATE TRIGGER review_event_no_truncate
    BEFORE TRUNCATE ON review_event
    FOR EACH STATEMENT EXECUTE FUNCTION review_event_append_only();
