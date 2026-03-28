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

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/mark_played' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/

// supabase/functions/mark_played/index.ts
// Edge Function que registra que el usuario escuchó un track.
// Actualiza last_played_at en la tabla tracks.
// Llamada desde el dashboard (GitHub Pages) al hacer clic en "✓ Escuchada".

import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";

// Regex para validar formato UUID v4
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight CORS para el frontend en GitHub Pages
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Parsear body ---
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body inválido: se esperaba JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (typeof body !== "object" || body === null) {
    return new Response(JSON.stringify({ error: "El body debe ser un objeto JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { track_id } = body as Record<string, unknown>;

  // --- Validar track_id ---
  if (!track_id || typeof track_id !== "string") {
    return new Response(JSON.stringify({ error: "track_id es obligatorio" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!UUID_REGEX.test(track_id)) {
    return new Response(JSON.stringify({ error: "track_id no es un UUID válido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Cliente Supabase con service_role ---
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // --- Verificar que el track existe ---
  const { data: existing, error: lookupError } = await supabase
    .from("tracks")
    .select("id")
    .eq("id", track_id)
    .maybeSingle();

  if (lookupError) {
    console.error("Error al verificar track:", lookupError);
    return new Response(JSON.stringify({ error: "Error interno al verificar el track" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!existing) {
    return new Response(JSON.stringify({ error: "Track no encontrado" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Actualizar last_played_at ---
  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("tracks")
    .update({ last_played_at: now })
    .eq("id", track_id);

  if (updateError) {
    console.error("Error al actualizar last_played_at:", updateError);
    return new Response(JSON.stringify({ error: "Error interno al registrar la escucha" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ track_id, last_played_at: now }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});