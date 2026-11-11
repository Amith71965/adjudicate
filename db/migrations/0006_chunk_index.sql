-- Phase-3 retrieval units: overlapping windows over reasoning sections, with a local
-- embedding (pgvector, cosine HNSW) and a lexical tsvector (GIN), fused by RRF in code.
CREATE TABLE chunk (
    id               bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_id      bigint   NOT NULL,
    section_ordinal  smallint NOT NULL,
    ordinal          smallint NOT NULL CHECK (ordinal >= 0),
    start_char       integer  NOT NULL CHECK (start_char >= 0),  -- offsets into decision.text
    end_char         integer  NOT NULL,
    body             text     NOT NULL,
    fts              tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
    embedding        vector(384),
    embed_model      text,                                         -- which model made embedding
    -- Re-parsing replaces sections; their chunks go with them (derived data only).
    FOREIGN KEY (decision_id, section_ordinal)
        REFERENCES decision_section (decision_id, ordinal) ON DELETE CASCADE,
    UNIQUE (decision_id, section_ordinal, ordinal),
    CONSTRAINT chunk_span CHECK (end_char > start_char),
    CONSTRAINT chunk_embedding_iff_model CHECK ((embedding IS NULL) = (embed_model IS NULL))
);
CREATE INDEX chunk_embedding_hnsw ON chunk USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunk_fts_idx ON chunk USING gin (fts);
CREATE INDEX chunk_decision_idx ON chunk (decision_id);
