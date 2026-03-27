// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
// import "@supabase/functions-js/edge-runtime.d.ts"

// console.log("Hello from Functions!")

// Deno.serve(async (req) => {
//   const { name } = await req.json()
//   const data = {
//     message: `Hello ${name}!`,
//   }

//   return new Response(
//     JSON.stringify(data),
//     { headers: { "Content-Type": "application/json" } },
//   )
// })

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/ingest' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/

// supabase/functions/ingest/index.ts
// Edge Function que recibe descubrimientos musicales desde la extensión Chrome.
// Autentica con X-GMC-Secret, valida el payload, deduplica por URL e inserta en sources.

import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";

// Tipos de fuente que la extensión puede enviar.
// Los parsers históricos (spotify, shazam, bookmark, txt) insertan directamente
// con service_role desde GitHub Actions — no pasan por esta función.
const VALID_SOURCE_TYPES = [
  "youtube",
  "bandcamp",
  "soundcloud",
  "manual",
] as const;
type SourceType = (typeof VALID_SOURCE_TYPES)[number];

interface IngestPayload {
  url: string | null;
  raw_title: string;
  source_type: SourceType;
  yt_channel?: string;
  yt_thumbnail?: string;
  user_artist?: string;
  user_title?: string;
  note?: string;
}

interface ValidationError {
  field: string;
  message: string;
}

/** Valida el payload entrante. Retorna lista de errores (vacía = válido). */
function validatePayload(body: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof body !== "object" || body === null) {
    return [{ field: "body", message: "El body debe ser un objeto JSON" }];
  }

  const payload = body as Record<string, unknown>;

  // raw_title es obligatorio
  if (
    !payload.raw_title ||
    typeof payload.raw_title !== "string" ||
    payload.raw_title.trim() === ""
  ) {
    errors.push({
      field: "raw_title",
      message: "raw_title es obligatorio y no puede estar vacío",
    });
  }

  // source_type debe pertenecer al enum
  if (
    !payload.source_type ||
    !VALID_SOURCE_TYPES.includes(payload.source_type as SourceType)
  ) {
    errors.push({
      field: "source_type",
      message: `source_type debe ser uno de: ${VALID_SOURCE_TYPES.join(", ")}`,
    });
  }

  // note máximo 140 caracteres si está presente
  if (payload.note !== undefined && payload.note !== null) {
    if (typeof payload.note !== "string") {
      errors.push({ field: "note", message: "note debe ser string" });
    } else if (payload.note.length > 140) {
      errors.push({
        field: "note",
        message: "note no puede superar 140 caracteres",
      });
    }
  }

  // url debe ser string si está presente (puede ser null explícito)
  if (
    payload.url !== undefined &&
    payload.url !== null &&
    typeof payload.url !== "string"
  ) {
    errors.push({ field: "url", message: "url debe ser string o null" });
  }

  return errors;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight CORS para la extensión Chrome
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Autenticación con shared secret ---
const incomingSecret = req.headers.get("x-gmc-secret") ?? "";
const expectedSecret = Deno.env.get("GMC_INGEST_SECRET") ?? "";

console.log({
  incomingLen: incomingSecret.length,
  expectedLen: expectedSecret.length,
  incomingJson: JSON.stringify(incomingSecret),
  expectedJson: JSON.stringify(expectedSecret),
  equal: incomingSecret === expectedSecret,
});

  if (!expectedSecret) {
    console.error(
      "GMC_INGEST_SECRET no está configurado en los secrets de la Edge Function",
    );
    return new Response(
      JSON.stringify({ error: "Configuración interna incorrecta" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  if (!incomingSecret || incomingSecret !== expectedSecret) {
    return new Response(JSON.stringify({ error: "No autorizado" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Parsear body ---
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Body inválido: se esperaba JSON" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // --- Validar payload ---
  const errors = validatePayload(body);
  if (errors.length > 0) {
    return new Response(
      JSON.stringify({ error: "Payload inválido", details: errors }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const payload = body as IngestPayload;

  // --- Cliente Supabase con service_role (bypasea RLS) ---
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // --- Deduplicación por URL ---
  // Solo aplicable cuando la URL no es null. La deduplicación sin URL
  // la maneja el índice parcial uq_sources_no_url en la BD.
  if (payload.url) {
    const { data: existing, error: lookupError } = await supabase
      .from("sources")
      .select("id")
      .eq("url", payload.url)
      .maybeSingle();

    if (lookupError) {
      console.error("Error al verificar duplicado:", lookupError);
      return new Response(
        JSON.stringify({ error: "Error interno al verificar duplicados" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (existing) {
      return new Response(
        JSON.stringify({ error: "URL ya registrada", id: existing.id }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  }

  // --- Insertar en sources ---
  const record = {
    url: payload.url ?? null,
    raw_title: payload.raw_title.trim(),
    source_type: payload.source_type,
    yt_channel: payload.yt_channel ?? null,
    yt_thumbnail: payload.yt_thumbnail ?? null,
    user_artist: payload.user_artist?.trim() ?? null,
    user_title: payload.user_title?.trim() ?? null,
    note: payload.note?.trim() ?? null,
    discovered_at: new Date().toISOString(),
    status: "pending",
  };

  const { data: inserted, error: insertError } = await supabase
    .from("sources")
    .insert(record)
    .select("id")
    .single();

  if (insertError) {
    // El índice uq_sources_no_url puede disparar un conflict para entradas sin URL
    if (insertError.code === "23505") {
      return new Response(JSON.stringify({ error: "Registro ya existe" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.error("Error al insertar en sources:", insertError);
    return new Response(
      JSON.stringify({ error: "Error interno al guardar el registro" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  return new Response(JSON.stringify({ id: inserted.id }), {
    status: 201,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
