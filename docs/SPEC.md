# GMC — Especificación Técnica

## 1. Arquitectura

El sistema combina tres patrones:

- **Event-driven** para la ingesta continua: la extensión dispara un evento al descubrir una canción; la Edge Function lo procesa de forma inmediata y aislada.
- **Batch processing** para el enriquecimiento: GitHub Actions corre el ETL una vez por semana sin infraestructura permanente activa.
- **Jamstack** para la presentación: el frontend es un sitio estático pre-construido que consume JSON generados durante el batch, más fetch en vivo a Supabase para datos de la semana en curso.

El stack de backup local existe como **réplica offline del historial**, restaurada semanalmente desde un `pg_dump` generado por el ETL. No requiere infraestructura adicional: se restaura en el PostgreSQL local (Windows) con un script PowerShell y se explora con pgAdmin o psql.

### Diagrama de componentes

```plaintext
[Extensión Chrome]
    │  videos.list?id={videoId}&part=snippet,contentDetails
    │  POST IngestPayload
    ▼
[Edge Function: supabase/functions/ingest]   ← Deno, service_role key en env
    │  Valida payload  →  Deduplica por URL  →  INSERT sources (status='pending')
    ▼
[PostgreSQL — Supabase Free Tier]   ← fuente de verdad
    │
    │  ◄── GET /rest/v1/sources?status=eq.pending   (anon key + RLS, timeout 5s)
    │         ↑
    │  [Frontend — GitHub Pages]
    │  JSON pre-generados + fetch live con degradación graceful
    │
    │  (cada domingo 02:00 AM UTC)
    ▼
[GitHub Actions — weekly.yml]
    │
    ├─ [ETL Python: enrichment/main.py]
    │    1. Keep-alive ping (retry 10s, max 90s)
    │    2. SELECT sources WHERE status='pending'
    │    3. Por cada registro:
    │       a. Construir query: user_title+user_artist si existen, sino clean(raw_title)
    │       b. MusicBrainz search_recording(query)
    │          → mbid, title, duration_ms, album, artists
    │       c. Last.fm track.getInfo(artist, title)
    │          → genres, cover_url  (fallo no crítico)
    │       d. Upsert: albums → artists → tracks → track_artists
    │       e. UPDATE sources.status + processed_at
    │    4. Escribe processed_count en $GITHUB_OUTPUT
    │
    ├─ [Export Python: export/static.py]
    │    Queries → frontend/public/data/*.json
    │
    ├─ [Backup: backup/dump.sh]
    │    pg_dump de Supabase → artefacto GitHub Actions (retención 90 días)
    │
    └─ [Build + Deploy]  (solo si processed_count > 0 o workflow_dispatch)
         npm run build → dist/ → push gh-pages

                              [PostgreSQL local (Windows)]
                              Restaurado con restore_local.ps1
                              Exploración offline vía pgAdmin / psql
```

---

## 2. Stack tecnológico

| Componente         | Tecnología                                    | Justificación                                               |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------- |
| Extensión          | Chrome MV3 · JavaScript                       | Acceso nativo a tabs API; sin dependencias de build         |
| Metadatos YouTube  | YouTube Data API v3 (`videos.list`)           | Fuente oficial; 1 unidad de quota (vs 100 de `search.list`) |
| Edge Function      | Supabase Edge Functions (Deno/TypeScript)     | Proxy seguro sin exponer service_role al cliente            |
| Base de datos      | PostgreSQL 15 · Supabase Free Tier            | ACID, arrays nativos, API REST auto-generada                |
| Parsers históricos | Python 3.11 · BeautifulSoup · csv             | ETL sobre formatos reales ya verificados                    |
| ETL semanal        | Python 3.11 · GitHub Actions (cron)           | Sin infraestructura permanente; 2000 min/mes gratis         |
| Enriquecimiento    | MusicBrainz + `musicbrainzngs` · Last.fm      | Datos canónicos + géneros; ambos gratuitos                  |
| Frontend           | React 18 · Vite · Tailwind CSS · GitHub Pages | Build estático; CDN gratuito                                |
| Backup local       | pg_dump · PowerShell · PostgreSQL (Windows)   | Restauración offline sin infraestructura adicional          |

---

## 3. Modelo de datos

```sql
-- ============================================================
-- sources: buffer crudo de toda ingesta
-- ============================================================
CREATE TABLE sources (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url           TEXT,                            -- nullable para entradas sin URL
    raw_title     TEXT NOT NULL,                   -- título original sin modificar
    yt_channel    TEXT,                            -- canal YouTube (respaldo)
    yt_thumbnail  TEXT,                            -- URL thumbnail (respaldo)
    source_type   TEXT NOT NULL
                  CHECK (source_type IN ('youtube', 'bandcamp', 'soundcloud',
                                         'spotify', 'shazam', 'bookmark', 'txt', 'manual')),
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processed', 'failed', 'manual_review')),
    error_detail  TEXT,
    discovered_at TIMESTAMPTZ NOT NULL,            -- fecha real del descubrimiento (fuente original o now())
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(), -- fecha de inserción en el sistema
    processed_at  TIMESTAMPTZ,
    -- Overrides editables por el usuario en el popup de la extensión
    user_artist   TEXT,
    user_title    TEXT,
    note          TEXT CHECK (char_length(note) <= 140)  -- contexto libre del momento del descubrimiento
);

-- Deduplicación: dos estrategias según si hay URL o no
-- Para registros con URL: unicidad por URL
CREATE UNIQUE INDEX uq_sources_url
    ON sources(url) WHERE url IS NOT NULL;

-- Para registros sin URL (entradas manuales/TXT): unicidad por (raw_title, source_type)
CREATE UNIQUE INDEX uq_sources_no_url
    ON sources(raw_title, source_type) WHERE url IS NULL;

-- ============================================================
-- artists
-- ============================================================
CREATE TABLE artists (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    mbid       TEXT UNIQUE,                      -- MusicBrainz Artist ID
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- albums
-- ============================================================
CREATE TABLE albums (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        TEXT NOT NULL,
    mbid         TEXT UNIQUE,                    -- MusicBrainz Release ID
    release_year SMALLINT,
    cover_url    TEXT,                           -- Last.fm image URL
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- tracks: datos normalizados post-enriquecimiento
-- ============================================================
CREATE TABLE tracks (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id         UUID NOT NULL REFERENCES sources(id),  -- fuente primaria
    source_ids        UUID[] NOT NULL DEFAULT '{}',          -- todas las fuentes que resuelven este track
    mbid              TEXT UNIQUE,                           -- MusicBrainz Recording ID
    title             TEXT NOT NULL,
    album_id          UUID REFERENCES albums(id),            -- nullable: puede no resolverse
    duration_ms       INTEGER,
    genres            TEXT[],                                -- Last.fm tags
    last_suggested_at TIMESTAMPTZ,                           -- última vez incluido en playlist (NULL = nunca)
    last_played_at    TIMESTAMPTZ,                           -- última vez marcado como escuchado (NULL = nunca)
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
CREATE INDEX idx_sources_status         ON sources(status);
CREATE INDEX idx_sources_discovered_at  ON sources(discovered_at DESC);
CREATE INDEX idx_sources_created_at     ON sources(created_at DESC);
CREATE INDEX idx_tracks_created_at      ON tracks(created_at DESC);
CREATE INDEX idx_tracks_genres          ON tracks USING GIN(genres);
CREATE INDEX idx_tracks_source_ids      ON tracks USING GIN(source_ids);
CREATE INDEX idx_tracks_last_played     ON tracks(last_played_at DESC NULLS LAST);
CREATE INDEX idx_tracks_last_suggested  ON tracks(last_suggested_at DESC NULLS LAST);
```

### Decisiones de esquema

**Índices parciales para deduplicación:** PostgreSQL trata `NULL != NULL` en unicidad, por lo que dos filas con `url = NULL` no colisionan con un simple `UNIQUE`. Se usan dos índices parciales mutuamente excluyentes: uno activo cuando `url IS NOT NULL` y otro cuando `url IS NULL` (deduplicando por `raw_title + source_type`).

**`discovered_at` vs `created_at`:** `discovered_at` representa la fecha real en que el usuario encontró la canción (fecha de la fuente: ADD_DATE en bookmarks, TagTime en Shazam, "Añadido en" en Exportify; o `now()` para capturas nuevas). `created_at` es siempre la fecha de inserción en el sistema. Las playlists de redescubrimiento usan `discovered_at` para sus criterios temporales; las auditorías del sistema usan `created_at`. Para las fuentes históricas los parsers populan `discovered_at` con la fecha original de la fuente.

**`user_artist` / `user_title`:** cuando el usuario corrige los datos en el popup de la extensión, el ETL usa estos campos como query hacia MusicBrainz en lugar de limpiar `raw_title` con regex. Esto mejora significativamente la tasa de match.

**`note`:** campo libre de hasta 140 caracteres para capturar el contexto del momento del descubrimiento ("sonó en el video de X", "recomendado por canal Y"). El constraint `CHECK (char_length(note) <= 140)` se valida en BD; la extensión lo valida también en cliente antes del POST.

**`genres` como `TEXT[]`:** PostgreSQL soporta arrays nativamente con índice GIN para queries como `genres @> ARRAY['electronic']`. Evita una tabla de join para una relación de solo lectura en este dominio.

**`albums` como tabla separada:** permite queries analíticas por álbum y evita duplicar datos cuando múltiples tracks comparten álbum.

**`source_ids` en `tracks`:** cuando el mismo recording de MusicBrainz se resuelve desde múltiples fuentes (ej. misma canción en bookmarks y Shazam), `source_id` conserva la fuente primaria (primera en resolverse) y `source_ids` acumula todas las fuentes. El upsert hace `array_append` solo si el UUID no está ya presente. El frontend puede mostrar "también en Shazam, Spotify" sin complejidad de tabla N:M adicional.

**`last_suggested_at` y `last_played_at`:** cierran el ciclo de redescubrimiento. `last_suggested_at` se actualiza en cada export de playlists para evitar que las mismas canciones aparezcan semana tras semana. `last_played_at` se actualiza desde el dashboard cuando el usuario marca una canción como escuchada, y alimenta la priorización de "Para escuchar hoy".

---

## 4. Modelo de seguridad

```bash
Cliente (extensión)
  ├── YouTube API key       → expuesta en extensión; restringida a chrome-extension://{ID}/*
  ├── EDGE_FUNCTION_URL     → endpoint HTTP público
  ├── GMC_INGEST_SECRET     → shared secret enviado en header X-GMC-Secret en cada POST
  └── Sin credenciales Supabase  ✓

Edge Function (Deno, server-side)
  ├── ingest          → valida X-GMC-Secret; usa SUPABASE_SERVICE_ROLE_KEY; INSERT en sources
  └── mark_played     → usa SUPABASE_SERVICE_ROLE_KEY; UPDATE last_played_at en tracks

Frontend (GitHub Pages, client-side)
  ├── SUPABASE_URL          → expuesta; aceptable con RLS
  ├── SUPABASE_ANON_KEY     → expuesta; aceptable con RLS
  └── RLS: anon puede SELECT en sources, tracks, artists, albums  ✓
      anon NO puede escribir; las actualizaciones van por Edge Functions  ✓

GitHub Actions (ETL, parsers, backup)
  ├── SUPABASE_URL               → GitHub Secret  ✓
  ├── SUPABASE_SERVICE_ROLE_KEY  → GitHub Secret  ✓
  ├── LASTFM_API_KEY             → GitHub Secret  ✓
  └── GMC_INGEST_SECRET          → GitHub Secret  ✓ (no usado por el ETL, documentado por consistencia)
```

### Row Level Security

```sql
-- sources: anon puede leer (frontend muestra pendientes de la semana actual)
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_sources"
    ON sources FOR SELECT TO anon USING (true);

-- tracks, artists, albums: anon puede leer (fetch live para playlists dinámicas y feedback)
ALTER TABLE tracks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE albums  ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_tracks"  ON tracks  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_select_artists" ON artists FOR SELECT TO anon USING (true);
CREATE POLICY "anon_select_albums"  ON albums  FOR SELECT TO anon USING (true);

-- anon NO puede escribir en ninguna tabla: la Edge Function usa service_role que bypasea RLS.
-- No se define política INSERT/UPDATE para anon → denegado por defecto en todas las tablas.
```

> **Nota:** el sistema es personal (un solo usuario). RLS no actúa como control de acceso multi-tenant sino como capa de seguridad mínima para exponer `anon_key` en el frontend sin riesgo de escrituras no autorizadas. Las actualizaciones de `last_played_at` desde el dashboard se canalizan a través de una Edge Function dedicada con `service_role`, no directamente con `anon_key`.

---

## 5. Parsers históricos

Todos los parsers siguen el mismo contrato:

```python
def parse(filepath: str) -> list[dict]:
    """
    Retorna lista de dicts listos para bulk insert en sources.
    Nunca lanza excepción no controlada.
    Imprime resumen al finalizar: insertados / duplicados / errores.
    """
```

La inserción real a la BD es responsabilidad del orquestador (`parsers/runner.py`), no del parser individual. Esto permite testear los parsers sin BD.

### `parsers/bookmarks.py` — `music.html`

**Formato:** Netscape Bookmark File (HTML estándar de exportación de navegadores). URLs de `youtube.com` y `music.youtube.com` organizadas en carpetas anidadas.

**Extracción:**

- BeautifulSoup para parsear el HTML.
- Filtrar `<a>` cuyo `href` contenga `youtube.com` o `music.youtube.com`.
- `url` = valor del atributo `href`.
- `raw_title` = texto del `<a>` tal cual, **sin aplicar `clean_title()`**. El invariante de `raw_title` es preservar el texto original; `clean_title()` lo aplica el ETL al construir la query a MusicBrainz.
- `discovered_at` = `ADD_DATE` del atributo (Unix timestamp → `datetime` UTC).
- `created_at = now()` (fecha de inserción en el sistema).
- `source_type = 'bookmark'`.

### `parsers/shazam.py` — `shazamlibrary.csv`

**Formato:**

```plaintext
Shazam Library          ← línea 1: metadato, saltar
Index,TagTime,Title,Artist,URL,TrackKey  ← línea 2: header real
1,2026-01-03,"Here Me Now","Dreamcather",https://www.shazam.com/track/...,364580097
```

**Extracción:**

- Abrir con `csv.DictReader`, saltando la primera línea.
- `url` = columna `URL` (URL de Shazam, no nula → se usa para deduplicación).
- `raw_title` = `f"{row['Artist']} {row['Title']}"`.
- `discovered_at` = `TagTime` (formato `YYYY-MM-DD`, parsear como `date` → `datetime` en UTC).
- `created_at = now()` (fecha de inserción en el sistema).
- `source_type = 'shazam'`.
- Manejar valores vacíos en `Artist` o `Title` sin excepción.

### `parsers/exportify.py` — `liked.csv`

**Formato:** CSV de Exportify con 19 columnas y headers en español. Sin línea de metadato inicial.

```plaintext
"URI de la canción","Nombre de la canción","URI(s) del artista",
"Nombre(s) del artista","URI del álbum","Nombre del álbum",
"URI(s) del artista del álbum","Nombre(s) del artista del álbum",
"Fecha de lanzamiento del álbum","URL de la imagen del álbum",
"Número de disco","Número de la canción","Duración de la canción (ms)",
"URL de vista previa de la canción","Explícito","Popularidad",
"ISRC","Añadido por","Añadido en"
```

**Extracción:**

- `url` = `"URI de la canción"` (formato `spotify:track:{id}`, único por track → clave de deduplicación).
- `raw_title` = `f"{primer_artista} {nombre_cancion}"` donde `primer_artista` = primer elemento de `"Nombre(s) del artista"`.split(`, `)[0]`.
- `discovered_at` = `"Añadido en"` (formato ISO 8601: `2026-03-09T14:56:49Z`).
- `created_at = now()` (fecha de inserción en el sistema).
- `source_type = 'spotify'`.
- El campo `"Nombre(s) del artista"` puede contener múltiples artistas separados por `, `. El `raw_title` usa solo el primero; el ETL de enriquecimiento puede buscar todos si el primero no da resultado.

### `parsers/txt.py` — `radios.txt`

**Formato:** una entrada por línea, `Artista - Título`. Líneas en blanco y líneas con `#` son ignoradas.

**Extracción:**

- `url = None` (no hay URL para estas entradas).
- Si la línea contiene `-`: separar en `user_artist` y `user_title` con `split(' - ', 1)`.
- Si la línea no contiene `-`: guardar la línea completa como `raw_title` sin modificar.
- `raw_title` = la línea completa original (siempre, independiente de si se pudo separar).
- `discovered_at = now()` (no hay fecha en el archivo; se asume captura reciente).
- `created_at = now()`.
- `source_type = 'txt'`.
- Deduplicación: índice parcial `uq_sources_no_url` sobre `(raw_title, source_type)`.

### `parsers/runner.py` — orquestador de inserción

```python
# Responsabilidades:
# 1. Recibe lista de dicts de cualquier parser
# 2. Bulk insert con ON CONFLICT DO NOTHING (respeta ambos índices únicos)
# 3. Retorna (inserted: int, skipped: int, errors: int)
# 4. Usa psycopg2 con executemany o copy_records_to_table para eficiencia
```

---

## 6. ETL de enriquecimiento

### Utilidad compartida: `enrichment/utils.py`

Los patrones de limpieza de títulos se definen una sola vez aquí y son importados por `parsers/bookmarks.py` y el orquestador ETL.

```python
# enrichment/utils.py
import re

_CLEANUP_PATTERNS = [
    r'\s*-\s*YouTube Music\s*$',
    r'\s*-\s*YouTube\s*$',
    r'\s*\(Official\s*(Music\s*)?Video\)\s*$',
    r'\s*\(Official\s*Audio\)\s*$',
    r'\s*\[?(Lyrics?|lyric\s*video)\]?\s*$',
    r'\s*\(Music\s*Video\)\s*$',
]

def clean_title(raw: str) -> str:
    """Elimina sufijos de plataforma del título crudo para mejorar match en MusicBrainz."""
    result = raw
    for pattern in _CLEANUP_PATTERNS:
        result = re.sub(pattern, '', result, flags=re.IGNORECASE)
    return result.strip()
```

### Clientes externos

**`enrichment/clients/musicbrainz.py`**

```python
from dataclasses import dataclass

@dataclass
class RecordingData:
    mbid: str
    title: str
    duration_ms: int | None
    album_title: str | None
    album_mbid: str | None
    release_year: int | None
    artists: list[dict]  # [{"name": str, "mbid": str | None}]

def search_recording(query: str) -> RecordingData | None:
    """
    Busca un recording en MusicBrainz por texto libre.
    Retorna None si no hay resultados.
    Lanza MusicBrainzError (tipada) en error de red o timeout.
    """
```

- `musicbrainzngs.set_useragent` configurado desde env vars.
- Rate limit gestionado automáticamente por la librería.
- Usa `release-list[0]` como álbum principal.

**`enrichment/clients/lastfm.py`**

```python
@dataclass
class LastFmInfo:
    genres: list[str]   # tags.tag[].name, máximo 5
    cover_url: str | None

def get_track_info(artist: str, title: str) -> LastFmInfo | None:
    """
    Obtiene géneros y portada desde Last.fm track.getInfo.
    Retorna None si el track no existe o la respuesta está incompleta.
    No lanza excepción (enriquecimiento secundario, no crítico).
    """
```

- `httpx.Client` síncrono con timeout de 10s (consistente con `musicbrainzngs` síncrono; evita mezclar `asyncio.run()` por registro en el orquestador).
- `time.sleep(0.2)` entre llamadas (conservador, ~5 req/s).

### Flujo por registro

```bash
source (status='pending')
    │
    │  Query a MusicBrainz:
    │    user_title + " " + user_artist   → si ambos existen
    │    user_title                        → si solo existe user_title
    │    user_artist                       → si solo existe user_artist
    │    clean_title(raw_title)            → si ninguno existe
    ▼
MusicBrainz search_recording(query)
    ├── None       → status = 'manual_review'  (fin)
    └── RecordingData →
            ▼
        Last.fm get_track_info(artists[0].name, recording.title)
            ├── None      → continúa con genres=[], cover_url=None
            └── LastFmInfo →
                    ▼
                Upsert en BD (dentro de una transacción):
                  1. albums  ON CONFLICT (mbid) DO UPDATE SET title, release_year, cover_url
                  2. artists ON CONFLICT (mbid) DO UPDATE SET name
                  3. tracks  ON CONFLICT (mbid) DO UPDATE SET
                               title, album_id, duration_ms, genres,
                               source_ids = (
                                 CASE WHEN EXCLUDED.source_id = ANY(tracks.source_ids)
                                      THEN tracks.source_ids
                                      ELSE array_append(tracks.source_ids, EXCLUDED.source_id)
                                 END
                               )
                  4. track_artists ON CONFLICT DO NOTHING
                  5. UPDATE sources SET status='processed', processed_at=now()

Error inesperado:
    → UPDATE sources SET status='failed', error_detail=repr(exception)
    → continuar con el siguiente registro (no abortar el batch)
```

### Rate limits

| API         | Límite                    | Estrategia                                          |
| ----------- | ------------------------- | --------------------------------------------------- |
| MusicBrainz | 1 req/s                   | `musicbrainzngs` gestiona automáticamente           |
| Last.fm     | ~5 req/s (no documentado) | `time.sleep(0.2)` entre llamadas (cliente síncrono) |

---

## 7. Export de JSON estáticos

`export/static.py` genera los siguientes archivos en `frontend/public/data/`. Las playlists se dividen en dos categorías según su ciclo de actualización:

**Playlists estáticas** (generadas cada domingo por el ETL, consumidas como JSON):

| Archivo                   | Query base                                                                                                                                                       | Uso en frontend       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `recent_tracks.json`      | JOIN `tracks ↔ sources` (en `tracks.source_id`); `ORDER BY sources.discovered_at DESC LIMIT 50`; incluye `sources.note`                                         | Historial reciente    |
| `playlist_forgotten.json` | JOIN `tracks ↔ sources`; `discovered_at < now() - interval '6 months'` AND (`last_suggested_at IS NULL` OR `last_suggested_at < now() - interval '4 weeks'`) `ORDER BY RANDOM() LIMIT 20`; incluye `sources.note` | "Joyas olvidadas"     |
| `playlist_by_genre.json`  | `UNNEST(genres)` + `GROUP BY` + top 10 géneros                                                                                                                   | Navegación por género |
| `playlist_by_era.json`    | `DATE_TRUNC('quarter', sources.discovered_at)` + `GROUP BY`; JOIN con `sources`                                                                                  | Línea de tiempo       |
| `stats.json`              | Totales: tracks, artistas, álbumes, géneros únicos, breakdown mensual                                                                                            | Estadísticas          |

> **Nota sobre `sources.note`:** todos los JSON que renderizan cards de tracks individuales deben incluir el campo `note` de la tabla `sources` (JOIN por `tracks.source_id`). Es el único campo que requiere este JOIN en el export estático; el resto de metadatos vive en `tracks`, `artists` y `albums`.

**Playlists dinámicas** (fetch live a Supabase con `anon_key`; degradación graceful si timeout):

| Endpoint Supabase REST                                                                      | Uso en frontend                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/rest/v1/tracks?order=last_played_at.asc.nullsfirst&limit=20`                              | "Para escuchar hoy" (prioriza no escuchadas o escuchadas hace más tiempo) |
| `/rest/v1/sources?status=eq.pending&discovered_at=gte.{lunes_ISO}&order=discovered_at.desc` | "Esta semana"                                                             |
| `/rest/v1/sources?status=in.(manual_review,failed)`                                         | Sección de gestión manual                                                 |

> **Imagen de portada:** cuando un track tiene tanto `yt_thumbnail` (en `sources`) como `cover_url` (en `albums`), el frontend prioriza `cover_url` de Last.fm por ser artwork oficial. `yt_thumbnail` actúa como placeholder mientras el track está en estado `pending`.

**Post-export — actualizar `last_suggested_at`:** el script actualiza `last_suggested_at` **antes** de escribir `playlist_forgotten.json`. Este orden es intencional: si la escritura del archivo falla, re-ejecutar el ETL excluirá correctamente los tracks ya marcados. Si se hiciera al revés y el UPDATE fallara tras escribir el JSON, los mismos tracks reaparecerían la semana siguiente.

```python
# export/static.py — orden correcto: UPDATE primero, escritura de archivo después
track_ids = [t["id"] for t in forgotten_tracks]
if track_ids:
    cursor.execute(
        "UPDATE tracks SET last_suggested_at = now() WHERE id = ANY(%s)",
        (track_ids,)
    )
    conn.commit()

# Solo después de confirmar el commit, escribir el archivo
with open("frontend/public/data/playlist_forgotten.json", "w") as f:
    json.dump(forgotten_tracks, f)
```

Si no hay tracks procesados, genera JSON con arrays vacíos (no falla).

---

## 8. Extensión Chrome

### Estructura

```bash
extension/
├── manifest.json
├── config.js              # YOUTUBE_API_KEY + EDGE_FUNCTION_URL (en .gitignore)
├── background.js          # Service worker (MV3, no usado activamente)
└── popup/
    ├── popup.html
    ├── popup.js
    └── popup.css
```

### Payload hacia la Edge Function

```typescript
interface IngestPayload {
  url: string | null;
  raw_title: string; // construido por el cliente; ver lógica abajo
  source_type: "youtube" | "bandcamp" | "soundcloud" | "manual";
  yt_channel?: string;
  yt_thumbnail?: string;
  user_artist?: string;
  user_title?: string;
  note?: string; // máximo 140 caracteres; validado en cliente y en BD
}
```

### Flujo interno del popup

```plaintext
1. chrome.tabs.query → URL de la pestaña activa
2. Si youtube.com / music.youtube.com:
     extraer videoId del parámetro ?v= o de la URL de music.youtube.com
     fetch videos.list?id={videoId}&part=snippet,contentDetails  (1 unidad quota)
     → renderizar preview con campos editables (artista, título, nota opcional)
     → raw_title = título del video sin modificar (clean_title lo procesa el ETL)
   Si otra URL:
     modo manual → formulario artista + título + URL pre-completada + nota opcional
     → raw_title = [user_artist, user_title].filter(Boolean).join(' - ')
                   Si solo existe uno de los dos, se usa ese valor como raw_title.
                   raw_title es respaldo; el ETL usa user_artist/user_title directamente.
3. Clic en "Guardar":
     Validar: al menos user_artist o user_title presente (modo manual)
     Validar: note.length <= 140 si se ingresó nota
     POST a EDGE_FUNCTION_URL con payload
     → 201: mostrar "✓ Guardado"
     → 409: mostrar "Ya registrada"
     → otro error: mostrar mensaje descriptivo
```

---

## 9. Backup local — `restore_local.ps1`

No existe infraestructura FastAPI/Docker. El backup local es un `pg_dump` generado semanalmente por el ETL y almacenado como artefacto en GitHub Actions. Para exploración offline se restaura directamente en el PostgreSQL local de Windows y se navega con pgAdmin o psql.

### Relación con Supabase

```plaintext
Supabase PostgreSQL  ──►  pg_dump (GitHub Actions)  ──►  artefacto GitHub
                                                               │
                                                     restore_local.ps1
                                                               │
                                                    PostgreSQL local (Windows)
                                                    Exploración: pgAdmin / psql
```

### Script `backup/restore_local.ps1`

Requiere: `gh` CLI autenticado con permisos `actions:read`, y `pg_restore` disponible en PATH (incluido con la instalación estándar de PostgreSQL).

```powershell
# backup/restore_local.ps1
# Uso: .\restore_local.ps1 [-DbName gmc] [-DbUser postgres]
# Prereqs: gh CLI autenticado, pg_restore en PATH

param(
    [string]$DbName = "gmc",
    [string]$DbUser = "postgres",
    [string]$Repo   = "TU_USUARIO/gmc"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TmpDir = Join-Path $env:TEMP "gmc_restore_$(Get-Random)"
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
    Write-Host "Buscando último artefacto de backup en $Repo..."
    # gh descarga el artefacto más reciente que coincida con el patrón
    gh run download `
        --repo $Repo `
        --name "gmc-backup-*" `
        --dir $TmpDir `
        2>&1 | Write-Host

    $DumpFile = Get-ChildItem -Path $TmpDir -Filter "*.dump" -Recurse |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1

    if (-not $DumpFile) {
        throw "No se encontró ningún archivo .dump en el artefacto descargado."
    }

    Write-Host "Restaurando '$($DumpFile.Name)' en base de datos '$DbName'..."
    # --clean elimina objetos existentes antes de recrearlos
    # --no-owner y --no-acl evitan conflictos de permisos con el usuario local
    & pg_restore `
        --clean `
        --if-exists `
        --no-owner `
        --no-acl `
        --dbname $DbName `
        --username $DbUser `
        $DumpFile.FullName

    Write-Host "Restauración completada: $($DumpFile.Name)"
}
finally {
    Remove-Item -Recurse -Force $TmpDir
}
```

### Creación de la base de datos local (primera vez)

```powershell
# Crear la base de datos si no existe (ejecutar una sola vez)
psql -U postgres -c "CREATE DATABASE gmc;"
```

Tras la primera restauración, las ejecuciones posteriores de `restore_local.ps1` usan `--clean --if-exists` para actualizar sin recrear la base de datos.

---

## 10. GitHub Actions — `weekly.yml`

```yaml
on:
  schedule:
    - cron: "0 2 * * 0" # Domingo 02:00 AM UTC
  workflow_dispatch: # Ejecución manual

jobs:
  etl:
    runs-on: ubuntu-latest
    outputs:
      processed_count: ${{ steps.run.outputs.processed_count }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: pip install -r etl/requirements.txt
      - id: run
        run: python etl/enrichment/main.py
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          LASTFM_API_KEY: ${{ secrets.LASTFM_API_KEY }}

  export:
    needs: etl
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: pip install -r etl/requirements.txt
      - run: python etl/export/static.py
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
      - uses: actions/upload-artifact@v4
        with:
          name: static-data
          path: frontend/public/data/

  backup:
    needs: etl
    runs-on: ubuntu-latest
    steps:
      - name: pg_dump de Supabase
        run: |
          pg_dump "$SUPABASE_DB_URL" --no-owner --no-acl -Fc -f gmc_backup.dump
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
      - uses: actions/upload-artifact@v4
        with:
          name: gmc-backup-${{ github.run_id }}
          path: gmc_backup.dump
          retention-days: 90

  deploy:
    needs: [etl, export]
    if: needs.etl.outputs.processed_count != '0' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: static-data
          path: frontend/public/data/
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci && npm run build
        working-directory: frontend
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: frontend/dist
```

---

### `keepalive.yml`

```yaml
on:
  schedule:
    - cron: "0 12 * * *"   # 12:00 UTC diario; evita la pausa automática del Free Tier
  workflow_dispatch:

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Supabase REST API
        run: |
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "apikey: $SUPABASE_ANON_KEY" \
            "$SUPABASE_URL/rest/v1/")
          echo "Supabase responded: $STATUS"
          if [ "$STATUS" != "200" ]; then
            echo "WARNING: Supabase returned non-200 status ($STATUS)"
            exit 1
          fi
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
```

Este workflow no procesa ni modifica datos. Usa `anon_key` (no `service_role`). Si Supabase devuelve un status distinto de 200, el job falla y GitHub notifica por email. El ETL dominical tiene su propio keep-alive con retry de 90s al inicio de `enrichment/main.py`; este workflow es complementario y cubre los días en que no hay ETL.

---

## 11. Frontend

### Comportamiento de datos

```plaintext
Al cargar:
  1. Lee JSON estáticos (siempre disponibles desde el último build)
  2. Fetches live a Supabase (anon_key, timeout 5s c/u, degradación graceful):
       a. sources?status=eq.pending
            &discovered_at=gte.{ISO_inicio_lunes}
            &order=discovered_at.desc
          → sección "Esta semana" (solo capturas de la semana actual)
       b. tracks?order=last_played_at.asc.nullsfirst&limit=20
          → sección "Para escuchar hoy" (prioriza no escuchadas)
       c. sources?status=in.(manual_review,failed)
          → sección de gestión manual
       Timeout en cualquier fetch → mostrar solo datos estáticos
                                  + indicador "Última actualización: {fecha del build}"
  3. Acción "✓ Escuchada":
       POST a Edge Function mark_played con { track_id }
       → actualiza last_played_at en BD
       → reordena la lista localmente sin reload
```

### Secciones

| Sección               | Fuente                    | Notas                                                            |
| --------------------- | ------------------------- | ---------------------------------------------------------------- |
| Esta semana           | Fetch live a Supabase     | Pendientes descubiertos desde el lunes actual                    |
| Para escuchar hoy     | Fetch live a Supabase     | Prioriza `last_played_at IS NULL` o más antigua                  |
| Joyas olvidadas       | `playlist_forgotten.json` | Estático; criterio temporal + `last_suggested_at`                |
| Por género            | `playlist_by_genre.json`  | Estático                                                         |
| Por época             | `playlist_by_era.json`    | Estático; usa `discovered_at`                                    |
| Pendientes / Fallidos | Fetch live a Supabase     | `status IN (manual_review, failed)`; con formulario de reintento |

---

## 12. Backlog

### Convenciones

**Ramas:** `feature/GMC-{ID}-{descripcion-corta}` → PR hacia `main`
**Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`)

### Definition of Done

- Código sin errores en el entorno local o servicio correspondiente.
- Mergeado en `main` con al menos un commit descriptivo.
- README o SPEC refleja el cambio si es relevante.
- Python: PEP 8, type hints en todas las funciones públicas, docstrings en funciones no triviales.
- JS/TS: ESLint standard, sin `console.log` en código no-debug.

---

### Épica 1 — Supabase (BD en nube + Edge Functions)

> La Épica de infraestructura Docker/FastAPI/Alembic ha sido eliminada. El backup local se gestiona con `restore_local.ps1` (ver §9), sin infraestructura adicional.

**GMC-01 · Esquema inicial en Supabase**

Criterios de aceptación:

- `supabase/schema.sql` ejecutable desde el SQL Editor de Supabase sin errores.
- Incluye tablas, índices parciales de deduplicación y RLS.
- RLS habilitado en `sources`, `tracks`, `artists` y `albums`; política `anon SELECT` activa en todas.
- Política `anon_select_sources` y equivalentes verificables desde el cliente con `anon_key`.

**GMC-02 · Edge Functions `ingest` y `mark_played`**

Criterios de aceptación — `ingest`:

- Rechaza la petición con 401 si el header `X-GMC-Secret` no coincide con la variable de entorno `GMC_INGEST_SECRET`.
- Valida campos requeridos; retorna 400 con detalle si faltan.
- Valida `note.length <= 140` si está presente; retorna 400 si excede.
- Valida que `source_type` pertenezca al enum definido; retorna 400 si no.
- Detecta duplicados por URL (cuando no es null); retorna 409 sin insertar.
- Inserta correctamente con todos los campos opcionales incluido `note`.
- Retorna 201 con `{ id: uuid }` en éxito.
- `SUPABASE_SERVICE_ROLE_KEY` y `GMC_INGEST_SECRET` exclusivamente desde env secrets de Supabase.

Criterios de aceptación — `mark_played`:

- Acepta `{ track_id: uuid }` en el body.
- Retorna 400 si `track_id` está ausente o no es UUID válido.
- Retorna 404 si el track no existe.
- Actualiza `last_played_at = now()` y retorna 200 con `{ track_id, last_played_at }`.

---

### Épica 2 — Workflows de mantenimiento

**GMC-03 · `keepalive.yml` — ping diario a Supabase**

El workflow `keepalive.yml` genera actividad diaria en el proyecto de Supabase para evitar que el Free Tier entre en pausa por inactividad. Es un `curl` simple que no procesa datos.

```yaml
on:
  schedule:
    - cron: "0 12 * * *"   # 12:00 UTC diario

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Supabase healthcheck
        run: |
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "apikey: $SUPABASE_ANON_KEY" \
            "$SUPABASE_URL/rest/v1/")
          echo "Supabase responded: $STATUS"
          if [ "$STATUS" != "200" ]; then
            echo "WARNING: Supabase returned non-200 status ($STATUS)"
            exit 1
          fi
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
```

Criterios de aceptación:

- El workflow se ejecuta diariamente a las 12:00 UTC sin `workflow_dispatch` manual.
- Si Supabase responde con un status distinto de 200, el job falla y GitHub notifica por email.
- No procesa ni modifica datos; usa `anon_key` (no `service_role`).
- El ETL dominical tiene su propio keep-alive con retry de 90s al inicio; este workflow es complementario, no reemplaza ese mecanismo.

**GMC-04 · `restore_local.ps1` — script de restauración offline**

Criterios de aceptación:

- El script descarga el artefacto de backup más reciente usando `gh` CLI.
- Restaura en el PostgreSQL local de Windows con `pg_restore --clean --if-exists --no-owner --no-acl`.
- Falla explícitamente con mensaje descriptivo si no encuentra el archivo `.dump` o si `pg_restore` devuelve error.
- Limpia los archivos temporales en el bloque `finally` (se ejecuta incluso si hay error).
- El README del directorio `backup/` documenta los prerrequisitos (`gh` CLI autenticado, `pg_restore` en PATH) y el comando para crear la base de datos la primera vez.

---

### Épica 3 — Parsers históricos

**GMC-05 · Parser de bookmarks HTML**

Criterios de aceptación:

- Filtra solo URLs de `youtube.com` y `music.youtube.com`.
- `raw_title` = texto del `<a>` sin modificar; **no aplica `clean_title()`** (el invariante de `raw_title` es preservar el texto original; `clean_title()` lo aplica el ETL al construir la query).
- Preserva `ADD_DATE` como `discovered_at` (Unix timestamp → datetime UTC).
- `created_at = now()` (fecha de inserción).
- Maneja HTML malformado sin fallar silenciosamente.

**GMC-06 · Parser de Shazam CSV**

Criterios de aceptación:

- Salta la primera línea `"Shazam Library"` correctamente.
- Maneja valores nulos en `Artist` y `Title` sin excepción.
- `discovered_at` parseado desde `TagTime` (formato `YYYY-MM-DD`).
- `created_at = now()`.

**GMC-07 · Parser de Exportify CSV**

Criterios de aceptación:

- Lee correctamente las 19 columnas con headers en español.
- `url` = URI de Spotify (`spotify:track:{id}`), usado como clave de deduplicación.
- `raw_title` = primer artista + nombre de canción.
- `discovered_at` parseado desde `"Añadido en"` (ISO 8601). `created_at = now()`.
- Maneja artistas múltiples (campo separado por `, `) sin excepción.

**GMC-08 · Parser de TXT manual**

Criterios de aceptación:

- Ignora líneas vacías y líneas con `#`.
- Separa en `user_artist` y `user_title` cuando hay `-`.
- Guarda línea completa como `raw_title` siempre, independiente de la separación.
- `url = None`; deduplicación por `(raw_title, source_type)`.

**GMC-09 · Runner de inserción batch**

Criterios de aceptación:

- Acepta la salida de cualquier parser.
- Bulk insert con `ON CONFLICT DO NOTHING` (respeta ambos índices únicos).
- Imprime resumen: insertados / omitidos / errores.
- Re-ejecutable sobre el mismo archivo sin duplicados.

---

### Épica 4 — Extensión Chrome

**GMC-10 · Captura desde YouTube**

Criterios de aceptación:

- Extrae `videoId` del parámetro `?v=` en `youtube.com` y `music.youtube.com`.
- Llama a `videos.list?id={videoId}&part=snippet,contentDetails` (1 unidad quota).
- Muestra preview con campos editables: artista y título.
- El POST a la Edge Function incluye el header `X-GMC-Secret` con el valor de `config.js`.
- Muestra `✓ Guardado` en éxito o mensaje descriptivo en error.
- `409` muestra `"Ya registrada"` sin tratarlo como error.

**GMC-11 · Modo manual**

Criterios de aceptación:

- Toggle en el popup activa el formulario manual.
- Acepta URL (opcional), Artista, Título. Al menos Artista o Título es obligatorio.
- URL de la pestaña activa se pre-completa en el campo URL.
- Mismo flujo de envío que GMC-10.

---

### Épica 5 — ETL semanal + backup

**GMC-12 · Cliente MusicBrainz + utilidad `clean_title`**

Criterios de aceptación:

- `enrichment/utils.py` implementa `clean_title(raw: str) -> str` con los patrones definidos en §6.
- `set_useragent` configurado desde env vars.
- `search_recording(query: str) -> RecordingData | None` con type hints completos.
- Extrae todos los campos del dataclass `RecordingData`.
- Sin resultados → `None`. Error de red → excepción tipada `MusicBrainzError`.

**GMC-13 · Cliente Last.fm**

Criterios de aceptación:

- `get_track_info(artist: str, title: str) -> LastFmInfo | None` (síncrono; usa `httpx.Client`).
- Máximo 5 géneros extraídos de `tags.tag`.
- Track no encontrado → `None` sin excepción.

**GMC-14 · Orquestador ETL**

Criterios de aceptación:

- Keep-alive al inicio: ping con retry cada 10s, máximo 90s.
- Flujo completo por registro como se describe en la sección 6, incluyendo los cuatro casos de construcción de query.
- Upsert de `tracks` actualiza `source_ids` usando `EXCLUDED.source_id` en el `CASE`, acumulando fuentes sin duplicar UUIDs.
- Todos los upserts idempotentes (`ON CONFLICT DO UPDATE`).
- En el export de `playlist_forgotten`: actualiza `last_suggested_at` en BD **antes** de escribir el archivo JSON (ver §7).
- `processed_count` escrito en `$GITHUB_OUTPUT` como string numérico.
- Resumen final: procesados / manual_review / failed.

**GMC-15 · Export JSON + workflow completo**

Criterios de aceptación:

- Genera los 5 JSON estáticos en `frontend/public/data/` (arrays vacíos si no hay datos).
- Los JSON que renderizan cards de tracks individuales (`recent_tracks.json`, `playlist_forgotten.json`) incluyen el campo `note` obtenido via JOIN con `sources` en `tracks.source_id`.
- "Para escuchar hoy" es fetch live a Supabase; no existe `playlist_random.json` ni ningún JSON equivalente en el export estático.
- Workflow `weekly.yml` completo: cron, jobs con `checkout` y dependencias correctas, condición de deploy como comparación de string (`!= '0'`).
- Backup `pg_dump` como artefacto GitHub con retención de 90 días.
- Todos los secrets desde GitHub Secrets, incluyendo `GMC_INGEST_SECRET`.

---

### Épica 6 — Frontend dashboard

**GMC-16 · Dashboard**

Criterios de aceptación:

- Carga JSON estáticos y renderiza todas las secciones.
- Fetches live a Supabase con timeout 5s y degradación graceful en cada uno.
- Indicador de fecha de última actualización visible en todo momento.
- Cada track: título, artista, álbum, géneros (chips), portada (`cover_url` si existe, `yt_thumbnail` como fallback, placeholder si ninguno), nota del descubrimiento si existe, fuentes adicionales si `source_ids.length > 1`, enlace a URL original.
- Botón "✓ Escuchada" por track: llama a Edge Function `mark_played`; actualiza `last_played_at` localmente sin reload.
- Sección "Para escuchar hoy" prioriza tracks con `last_played_at IS NULL` o más antigua.
- Sección "Pendientes / Fallidos": cada item tiene formulario inline para editar `user_artist` y `user_title` y reenviarlos como `pending` para el próximo ETL.

