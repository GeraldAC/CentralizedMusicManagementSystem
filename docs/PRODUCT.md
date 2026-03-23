# GMC — Visión de Producto

## 1. Problema

El historial musical personal crece continuamente pero queda fragmentado entre fuentes: bookmarks de YouTube, historial de Shazam, canciones guardadas en Spotify, registros manuales de radios y Bandcamp. El problema real no es la dispersión sino que esas canciones quedan almacenadas y nunca se vuelven a escuchar.

GMC ataca dos momentos del ciclo de consumo musical:

**Momento 1 — El descubrimiento:** suena una canción en YouTube, interesa, hay que registrarla ahora o se pierde. El mecanismo de captura debe ser de cero fricción.

**Momento 2 — El redescubrimiento:** semanas o meses después, el usuario quiere volver a esas canciones. El sistema debe presentarlas de forma que invite a escuchar, no solo listar.

---

## 2. Restricciones de diseño

- **Costo cero ($0):** el sistema opera exclusivamente sobre Free Tiers de servicios en la nube.
- **Sin apps adicionales en el celular:** la captura sucede desde el navegador de escritorio. No se usa Telegram ni ninguna app extra.
- **Captura siempre disponible:** el mecanismo de ingesta no puede depender de servicios que hibernen. Los procesos de enriquecimiento pueden diferirse.
- **Datos de respaldo incluidos:** si una URL se rompe en el futuro, los metadatos capturados en el momento del descubrimiento deben ser suficientes para identificar la canción.
- **Backup local:** los datos en la nube se replican localmente de forma periódica. El sistema no depende exclusivamente de un servicio externo para acceder al historial.

---

## 3. Fuentes de datos

### Fuentes históricas (ingesta única o periódica)

| Archivo             | Formato                   | Contenido                                                                    |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `music.html`        | HTML (Netscape Bookmarks) | Bookmarks de YouTube y YouTube Music, organizados en carpetas por género     |
| `shazamlibrary.csv` | CSV                       | Historial de canciones identificadas con Shazam                              |
| `liked.csv`         | CSV (Exportify)           | Canciones guardadas en Spotify, exportadas vía Exportify                     |
| `radios.txt`        | TXT                       | Canciones descubiertas en radios u otras fuentes, formato `Artista - Título` |

### Ingesta continua (tiempo real)

Extensión de navegador Chrome, principalmente para YouTube y YouTube Music.

---

## 4. Flujos de usuario

### Flujo A — Captura desde YouTube

```plaintext
Usuario escucha una canción en YouTube o YouTube Music
    │
    ▼
Clic en el ícono de la extensión GMC en el navegador
    │
    ▼
La extensión detecta la URL y consulta la YouTube Data API
    │  → título, canal, thumbnail, duración
    ▼
El popup muestra una preview con los datos extraídos
    │  El usuario puede corregir artista y título si YouTube los muestra mal
    │  Campo opcional "nota" (≤140 caracteres) para capturar el contexto del momento
    ▼
Clic en "Guardar"
    │
    ▼
Registro almacenado en la BD  (estado: pendiente de enriquecimiento)
    │  URL + metadatos YouTube + correcciones del usuario + nota
    ▼
Confirmación visual en el popup  ("✓ Guardado")
```

Tiempo total: menos de 10 segundos.

### Flujo B — Captura manual (Bandcamp, SoundCloud, radio, etc.)

```plaintext
Usuario descubre una canción fuera de YouTube
    │
    ▼
Abre el popup → activa "Modo manual"
    │
    ▼
Ingresa: URL (opcional) + Artista + Título + Nota (opcional, ≤140 caracteres)
    │  Si hay URL, el título de la pestaña se usa como valor inicial
    │  Al menos Artista o Título es obligatorio
    ▼
Clic en "Guardar" → mismo flujo que A desde aquí
```

### Flujo C — Ingesta histórica (archivos acumulados)

```plaintext
Usuario ejecuta el parser correspondiente una vez (o periódicamente al obtener un nuevo export)
    │
    ▼
Script Python lee el archivo (HTML / CSV / TXT)
    │  → limpia, normaliza, deduplica
    ▼
Inserta registros nuevos en la BD con estado "pendiente"
    │  Duplicados detectados y omitidos automáticamente
    ▼
Resumen en consola: insertados / duplicados omitidos / errores
```

Los parsers son idempotentes: correr el mismo archivo dos veces no genera duplicados.

### Flujo D — Redescubrimiento (dashboard semanal)

```plaintext
Usuario abre el dashboard en el navegador
    │
    ▼
Ve la sección "Para escuchar hoy"
    │  Lista dinámica que prioriza canciones nunca escuchadas
    │  o escuchadas hace más tiempo (basado en last_played_at)
    ▼
Puede explorar por: género, época de descubrimiento, artista
    │
    ▼
Clic en una canción → abre la URL original (YouTube, Bandcamp, etc.)
    │
    ▼
Clic en "✓ Escuchada" → registra la escucha; la canción baja en prioridad
```

### Flujo E — Resolución manual de tracks no enriquecidos

```plaintext
Usuario abre la sección "Pendientes / Fallidos" del dashboard
    │
    ▼
Ve los tracks que el ETL no pudo enriquecer (status: manual_review o failed)
    │  Cada item muestra el raw_title y el error_detail si existe
    ▼
Usuario edita los campos Artista y Título con la información correcta
    │
    ▼
Clic en "Reintentar" → el registro vuelve a status='pending'
    │
    ▼
El próximo ETL del domingo lo procesa con los datos corregidos
```

---

## 5. Requisitos funcionales

### Captura

- La extensión funciona en `youtube.com` y `music.youtube.com`.
- En modo manual acepta cualquier combinación de URL, artista y título. Al menos uno de los dos últimos es obligatorio.
- Campo opcional "nota" disponible en todos los modos de captura. Máximo 140 caracteres, validado en cliente y en BD.
- Si la YouTube API no responde, la extensión guarda de todos modos con la URL y lo que el usuario ingresó.
- Si una URL ya fue registrada, el sistema lo indica sin guardar duplicado.

### Ingesta histórica

- Cada parser detecta y omite duplicados sin lanzar error.
- Los parsers preservan la fecha original de la fuente cuando está disponible (ADD_DATE en HTML, TagTime en Shazam, "Añadido en" en Exportify).
- Los parsers son re-ejecutables: al obtener un nuevo export de Shazam o Spotify, solo se insertan registros que no existan aún.

### Redescubrimiento

El sistema genera semanalmente las siguientes listas:

| Lista                 | Criterio                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| **Para escuchar hoy** | Fetch live; prioriza tracks con `last_played_at IS NULL` o más antigua                         |
| **Joyas olvidadas**   | Descubiertas hace más de 6 meses y no sugeridas en las últimas 4 semanas (`last_suggested_at`) |
| **Por género**        | Historial agrupado por género (tags de Last.fm), top 10 géneros                                |
| **Por época**         | Agrupado por trimestre de `discovered_at`                                                      |

El usuario puede marcar cualquier canción como "✓ Escuchada" desde el dashboard. Esto registra `last_played_at` y reordena la lista localmente sin recargar la página.

### Dashboard

- Muestra el historial con título, artista, álbum, géneros y portada cuando están disponibles. Si el track tiene nota de descubrimiento, se muestra como detalle contextual.
- Portada: prioriza `cover_url` de Last.fm sobre `yt_thumbnail`. Si ninguno está disponible, muestra placeholder.
- Si un mismo track fue capturado desde múltiples fuentes, muestra las fuentes adicionales ("también en Shazam, Spotify").
- Canciones pendientes de enriquecimiento (recién capturadas esta semana) aparecen en sección "Esta semana" con los datos de YouTube como placeholder.
- Canciones que el sistema no pudo enriquecer aparecen en sección "Pendientes / Fallidos" con formulario inline para corregir artista/título y reenviar como `pending`.
- Botón "✓ Escuchada" disponible en todas las secciones; actualiza `last_played_at` vía Edge Function sin reload.

---

## 6. Requisitos no funcionales

**Disponibilidad de captura:** la extensión puede guardar en cualquier momento. Supabase (Free Tier) no hiberna porque la extensión, el ETL semanal y un workflow de keep-alive diario generan actividad regular. El keep-alive diario es un `curl` simple al healthcheck de Supabase (`cron: '0 12 * * *'`); si Supabase está pausado, el siguiente ETL del domingo hace un ping con retry hasta 90s antes de comenzar.

**Disponibilidad del dashboard:** el sitio es estático (GitHub Pages), disponible 24/7 sin depender de la BD. Los datos dinámicos (esta semana, para escuchar hoy, fallidos) se obtienen vía fetch a Supabase con timeout de 5 segundos y degradación graceful si la BD no responde.

**Durabilidad:** cada registro en `sources` incluye los metadatos originales de la fuente como respaldo. Aunque un video sea eliminado o una URL cambie, artista y título permanecen en la BD.

**Línea de tiempo precisa:** `discovered_at` preserva la fecha real del descubrimiento según la fuente original (ADD_DATE en bookmarks, TagTime en Shazam, "Añadido en" en Exportify). Para capturas nuevas, `discovered_at = created_at = now()`. Las playlists por época y los criterios temporales de redescubrimiento usan `discovered_at`, no `created_at`.

**Idempotencia:** todos los scripts de ingesta y el ETL pueden ejecutarse múltiples veces sobre los mismos datos sin efectos duplicados.

**Backup local:** el ETL semanal genera un `pg_dump` de Supabase que se almacena como artefacto en GitHub Actions. El usuario puede restaurarlo en el entorno Docker local cuando necesite acceso offline al historial completo.

---

## 7. Lo que el sistema no es

- No es un reproductor de música. Solo enlaza de vuelta a la fuente original.
- No hace seguimiento de cuántas veces se escuchó cada canción post-captura.
- No reemplaza Spotify, Apple Music ni ningún servicio de streaming.
- No está diseñado para múltiples usuarios.
