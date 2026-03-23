# GMC — Gestor Musical Centralizado

Sistema de captura para descubrimientos musicales al instante y volver a escucharlos cuando se quiera.

## El problema

Las canciones favoritas se acumulan en fuentes dispersas (YouTube, Shazam, Spotify, archivos manuales) y rara vez se vuelven a escuchar. GMC resuelve dos cosas: capturar un descubrimiento en el momento exacto en que sucede, y presentar el historial acumulado de forma que invite a redescubrirlo.

## Arquitectura

```mermaid
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

| Componente         | Tecnología                                                                                                                                                                                                | Rol                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Extensión          | ![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-blue) ![JavaScript](https://img.shields.io/badge/JavaScript-ES6-yellow) ![YouTube API](https://img.shields.io/badge/YouTube-Data%20API%20v3-red)    | Captura inmediata con nota opcional                 |
| Ingesta            | ![Supabase](https://img.shields.io/badge/Supabase-Edge%20Functions-green) ![Deno](https://img.shields.io/badge/Deno-TypeScript-black)                                                                     | Proxy seguro hacia la BD                            |
| Base de datos      | ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-blue) ![Supabase](https://img.shields.io/badge/Supabase-Free%20Tier-green)                                                                       | Fuente de verdad en nube                            |
| Parsers históricos | ![Python](https://img.shields.io/badge/Python-3.11-yellow) ![BeautifulSoup](https://img.shields.io/badge/BeautifulSoup-ETL-lightgrey) ![CSV](https://img.shields.io/badge/CSV-parser-orange)              | Ingesta de archivos acumulados                      |
| ETL semanal        | ![Python](https://img.shields.io/badge/Python-3.11-yellow) ![GitHub Actions](https://img.shields.io/badge/GitHub-Actions-blue)                                                                            | Enriquecimiento + export + backup                   |
| Enriquecimiento    | ![MusicBrainz](https://img.shields.io/badge/MusicBrainz-ngs-orange) ![Last.fm](https://img.shields.io/badge/Last.fm-API-red)                                                                              | Metadatos canónicos + géneros                       |
| Frontend           | ![React](https://img.shields.io/badge/React-18-blue) ![Vite](https://img.shields.io/badge/Vite-build-purple) ![GitHub Pages](https://img.shields.io/badge/GitHub-Pages-lightgrey)                         | Dashboard estático + fetches live                   |
| Backup local       | ![pg_dump](https://img.shields.io/badge/pg_dump-backup-blue) ![PowerShell](https://img.shields.io/badge/PowerShell-scripts-darkblue) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Windows-green) | Restauración offline desde artefacto GitHub Actions |

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
| 1    | Supabase: esquema + Edge Functions             | ▣ Pendiente |
| 2    | Parsers históricos                             | ▣ Pendiente |
| 3    | Extensión Chrome                               | ▣ Pendiente |
| 4    | ETL semanal: enriquecimiento + export + backup | ▣ Pendiente |
| 5    | Frontend dashboard                             | ▣ Pendiente |

## Licencia

MIT
