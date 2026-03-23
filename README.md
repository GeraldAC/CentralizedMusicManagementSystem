# GMC — Gestor Musical Centralizado

Sistema de captura para descubrimientos musicales al instante y volver a escucharlos cuando se quiera.

## El problema

Las canciones favoritas se acumulan en fuentes dispersas (YouTube, Shazam, Spotify, archivos manuales) y rara vez se vuelven a escuchar. GMC resuelve dos cosas: capturar un descubrimiento en el momento exacto en que sucede, y presentar el historial acumulado de forma que invite a redescubrirlo.

## Arquitectura

```mermeid
flowchart TD
    %% Definición de Nodos y su contenido
    ExtChrome["<b>[Extensión Chrome]</b><br/>YouTube Data API v3<br/>Modo manual"]
    EdgeFunc["<b>[Edge Functions - Supabase]</b><br/>ingest: captura<br/>mark_played: feedback"]
    PGSupabase[("<b>[PostgreSQL - Supabase]</b><br/>Fuente de verdad (nube)")]

    Parsers["<b>[Parsers históricos]</b><br/>bookmarks HTML (music.html)<br/>Shazam CSV (shazamlibrary.csv)<br/>Exportify CSV (liked.csv)<br/>TXT manual (radios.txt)"]

    GHActions["<b>[GitHub Actions - cron]</b><br/>ETL Python semanal<br/>MusicBrainz + Last.fm<br/>Export JSON estáticos<br/>pg_dump → backup<br/>Build + Deploy frontend<br/>Keep-alive diario"]

    GHPages["<b>[GitHub Pages]</b><br/>React + Vite<br/>Dashboard"]
    PGLocal[("<b>[PostgreSQL local (Windows)]</b><br/>Restaurado con restore_local.ps1<br/>Exploración offline vía pgAdmin/psql")]

    %% Relaciones y flujo de datos
    ExtChrome --> EdgeFunc
    EdgeFunc --> PGSupabase
    Parsers --> PGSupabase

    PGSupabase --> GHActions

    GHActions --> GHPages
    GHActions --> PGLocal
```

## Componentes

| Componente         | Tecnología                                                   | Rol                                                 |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------------- |
| Extensión          | Chrome MV3 · JS · YouTube Data API v3                        | Captura inmediata con nota opcional                 |
| Ingesta            | Supabase Edge Functions (Deno/TS) · `ingest` + `mark_played` | Proxy seguro hacia la BD                            |
| Base de datos      | PostgreSQL · Supabase Free Tier                              | Fuente de verdad en nube                            |
| Parsers históricos | Python · BeautifulSoup · csv                                 | Ingesta de archivos acumulados                      |
| ETL semanal        | Python · GitHub Actions (cron)                               | Enriquecimiento + export + backup                   |
| Enriquecimiento    | MusicBrainz · Last.fm                                        | Metadatos canónicos + géneros                       |
| Frontend           | React · Vite · GitHub Pages                                  | Dashboard estático + fetches live                   |
| Backup local       | pg_dump · PowerShell · PostgreSQL local (Windows)            | Restauración offline desde artefacto GitHub Actions |

## Disponibilidad

| Función                    | Disponibilidad                                                      |
| -------------------------- | ------------------------------------------------------------------- |
| Captura de descubrimientos | Siempre (extensión + Supabase; keep-alive diario evita hibernación) |
| Dashboard                  | Siempre (GitHub Pages, archivos estáticos)                          |
| Datos enriquecidos         | Actualizados cada domingo 02:00 AM UTC                              |
| Feedback "Escuchada"       | Siempre (Edge Function `mark_played` + Supabase)                    |
| Backup local               | Sincronizado semanalmente vía pg_dump; restaurable con un comando   |

## Estructura del repositorio

```bash
CentralizedMusicManagementSystem/
├── docs/
│   ├── PRODUCT.md              # Visión, flujos y requisitos
│   └── SPEC.md                 # Arquitectura, esquema, backlog técnico
├── extension/                  # Chrome Extension (Manifest V3)
├── supabase/
│   ├── schema.sql
│   └── functions/
│       ├── ingest/             # Edge Function: captura (Deno)
│       └── mark_played/        # Edge Function: feedback de escucha (Deno)
├── etl/
│   ├── parsers/                # bookmarks, shazam, exportify, txt
│   ├── enrichment/             # MusicBrainz + Last.fm + utils.py
│   └── export/                 # JSON estáticos para el frontend
├── frontend/                   # React + Vite → GitHub Pages
│   └── public/data/            # JSON generados por el ETL
├── backup/
│   └── restore_local.ps1       # Restaura pg_dump en PostgreSQL local (Windows)
└── .github/workflows/
    ├── weekly.yml              # ETL + export + backup + deploy
    └── keepalive.yml           # Ping diario a Supabase
```

## Variables de entorno

```env
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=    # Solo servidor (GitHub Actions, Edge Functions)
SUPABASE_ANON_KEY=            # Frontend (público, protegido por RLS)
SUPABASE_DB_URL=              # Conexión directa a PostgreSQL (solo GitHub Actions, pg_dump)

# APIs externas
YOUTUBE_API_KEY=              # Restringida al Extension ID en Google Cloud Console
LASTFM_API_KEY=

# Seguridad ingesta
GMC_INGEST_SECRET=            # Shared secret entre extensión y Edge Function ingest
```

## Estado del proyecto

| Fase | Épica                                          | Estado      |
| ---- | ---------------------------------------------- | ----------- |
| 1    | Supabase: esquema + Edge Functions             | ◻ Pendiente |
| 2    | Parsers históricos                             | ◻ Pendiente |
| 3    | Extensión Chrome                               | ◻ Pendiente |
| 4    | ETL semanal: enriquecimiento + export + backup | ◻ Pendiente |
| 5    | Frontend dashboard                             | ◻ Pendiente |

## Licencia

MIT
