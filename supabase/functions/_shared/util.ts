import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "./cors.ts";

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const RESERVED_NAMES = ["everyone", "admin", "owner", "moderator", "mitglied"];
export const MIN_PASSWORD = 8;
export const PSEUDO_DOMAIN = "flarchat.local";

export function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Server nicht konfiguriert");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Liest den JSON-Body; liefert null bei ungültigem Body. */
export async function readBody(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function normUsername(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export function pseudoEmail(username: string): string {
  return `${username}@${PSEUDO_DOMAIN}`;
}

/** Gleichverteilte Zufallszahl 0..max-1 (Rejection Sampling). */
function randomInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

export function randomString(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// Ohne verwechselbare Zeichen (0/O, 1/I/L)
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TEMP_PW_ALPHABET =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export function generateRecoveryCode(): string {
  const raw = randomString(RECOVERY_ALPHABET, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeRecoveryCode(v: unknown): string {
  return typeof v === "string"
    ? v.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : "";
}

export function generateTempPassword(): string {
  return randomString(TEMP_PW_ALPHABET, 12);
}

const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) =>
  new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

async function pbkdf2(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Format: pbkdf2-sha256$<salt hex>$<hash hex> (Code ohne Bindestrich, groß). */
export async function hashRecovery(normalized: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${toHex(salt)}$${toHex(await pbkdf2(normalized, salt))}`;
}

export async function verifyRecovery(
  normalized: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 3 || parts[0] !== "pbkdf2-sha256") return false;
  const calc = await pbkdf2(normalized, fromHex(parts[1]));
  const exp = fromHex(parts[2]);
  if (calc.length !== exp.length) return false;
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc[i] ^ exp[i];
  return diff === 0;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
