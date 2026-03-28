-- =============================================================
-- GMC — Migración inicial
-- Archivo: supabase/migrations/20260325040736_initial_schema.sql
-- =============================================================

-- ============================================================
-- sources: buffer crudo de toda ingesta
-- ============================================================
CREATE TABLE sources (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url           TEXT,
    raw_title     TEXT NOT NULL,
    yt_channel    TEXT,
    yt_thumbnail  TEXT,
    source_type   TEXT NOT NULL
                  CHECK (source_type IN (
                      'youtube', 'bandcamp', 'soundcloud',
                      'spotify', 'shazam', 'bookmark', 'txt', 'manual'
                  )),
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processed', 'failed', 'manual_review')),
    error_detail  TEXT,
    discovered_at TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ,
    user_artist   TEXT,
    user_title    TEXT,
    note          TEXT CHECK (char_length(note) <= 140)
);

-- Deduplicación por URL cuando existe
CREATE UNIQUE INDEX uq_sources_url
    ON sources(url)
    WHERE url IS NOT NULL;

-- Deduplicación por (raw_title, source_type) para entradas sin URL
CREATE UNIQUE INDEX uq_sources_no_url
    ON sources(raw_title, source_type)
    WHERE url IS NULL;

-- ============================================================
-- artists
-- ============================================================
CREATE TABLE artists (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    mbid       TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- albums
-- ============================================================
CREATE TABLE albums (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        TEXT NOT NULL,
    mbid         TEXT UNIQUE,
    release_year SMALLINT,
    cover_url    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- tracks: datos normalizados post-enriquecimiento
-- ============================================================
CREATE TABLE tracks (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id         UUID NOT NULL REFERENCES sources(id),
    source_ids        UUID[] NOT NULL DEFAULT '{}',
    mbid              TEXT UNIQUE,
    title             TEXT NOT NULL,
    album_id          UUID REFERENCES albums(id),
    duration_ms       INTEGER,
    genres            TEXT[],
    last_suggested_at TIMESTAMPTZ,
    last_played_at    TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- track_artists: relación N:M
-- ============================================================
CREATE TABLE track_artists (
    track_id  UUID NOT NULL REFERENCES tracks(id),
    artist_id UUID NOT NULL REFERENCES artists(id),
    role      TEXT NOT NULL DEFAULT 'main'
              CHECK (role IN ('main', 'featured')),
    PRIMARY KEY (track_id, artist_id)
);

-- ============================================================
-- Índices de consulta frecuente
-- ============================================================
CREATE INDEX idx_sources_status        ON sources(status);
CREATE INDEX idx_sources_discovered_at ON sources(discovered_at DESC);
CREATE INDEX idx_sources_created_at    ON sources(created_at DESC);
CREATE INDEX idx_tracks_created_at     ON tracks(created_at DESC);
CREATE INDEX idx_tracks_genres         ON tracks USING GIN(genres);
CREATE INDEX idx_tracks_source_ids     ON tracks USING GIN(source_ids);
CREATE INDEX idx_tracks_last_played    ON tracks(last_played_at DESC NULLS LAST);
CREATE INDEX idx_tracks_last_suggested ON tracks(last_suggested_at DESC NULLS LAST);

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE albums  ENABLE ROW LEVEL SECURITY;

-- anon puede SELECT en todas las tablas; escrituras solo via Edge Functions (service_role)
CREATE POLICY "anon_select_sources" ON sources FOR SELECT TO anon USING (true);
CREATE POLICY "anon_select_tracks"  ON tracks  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_select_artists" ON artists FOR SELECT TO anon USING (true);
CREATE POLICY "anon_select_albums"  ON albums  FOR SELECT TO anon USING (true);