import { corsHeaders } from "../_shared/cors.ts";
import {
  adminClient,
  fail,
  generateRecoveryCode,
  hashRecovery,
  json,
  MIN_PASSWORD,
  normalizeRecoveryCode,
  normUsername,
  readBody,
  sleep,
  verifyRecovery,
} from "../_shared/util.ts";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const GENERIC =
  "Benutzername oder Wiederherstellungscode ist falsch, oder der Zugang ist vorübergehend gesperrt.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return fail("Methode nicht erlaubt.", 405);

  const started = Date.now();
  // Gleichmäßige Mindestdauer gegen Timing-Rückschlüsse und Raten
  const genericFail = async () => {
    const wait = 1200 - (Date.now() - started);
    if (wait > 0) await sleep(wait);
    return fail(GENERIC, 400);
  };

  try {
    const body = await readBody(req);
    if (!body) return fail("Ungültige Anfrage.");

    const username = normUsername(body.username);
    const code = normalizeRecoveryCode(body.recovery_code);
    const newPassword = typeof body.new_password === "string"
      ? body.new_password
      : "";

    if (newPassword.length < MIN_PASSWORD) {
      return fail(`Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen lang sein.`);
    }
    if (!username || code.length !== 8) return await genericFail();

    const db = adminClient();
    const { data: profile } = await db
      .from("profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();
    if (!profile) return await genericFail();

    const { data: secret } = await db
      .from("profile_secrets")
      .select("recovery_hash, recovery_failed, recovery_locked_until")
      .eq("user_id", profile.id)
      .maybeSingle();
    if (!secret) return await genericFail();

    if (
      secret.recovery_locked_until &&
      new Date(secret.recovery_locked_until).getTime() > Date.now()
    ) {
      return await genericFail();
    }

    const valid = await verifyRecovery(code, secret.recovery_hash);
    if (!valid) {
      const failed = (secret.recovery_failed ?? 0) + 1;
      const lock = failed >= MAX_FAILED;
      await db.from("profile_secrets").update({
        recovery_failed: lock ? 0 : failed,
        recovery_locked_until: lock
          ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
          : null,
      }).eq("user_id", profile.id);
      if (lock) {
        await db.from("audit_log").insert({
          actor_id: null,
          action: "recovery_locked",
          target: profile.id,
          details: { username },
        });
      }
      return await genericFail();
    }

    const { error: pwErr } = await db.auth.admin.updateUserById(profile.id, {
      password: newPassword,
    });
    if (pwErr) throw pwErr;

    const recovery = generateRecoveryCode();
    const { error: sErr } = await db.from("profile_secrets").update({
      recovery_hash: await hashRecovery(recovery.replace("-", "")),
      recovery_failed: 0,
      recovery_locked_until: null,
    }).eq("user_id", profile.id);
    if (sErr) throw sErr;

    await db.from("profiles")
      .update({ must_change_password: false })
      .eq("id", profile.id);
    await db.from("audit_log").insert({
      actor_id: profile.id,
      action: "password_reset_recovery",
      target: profile.id,
      details: {},
    });

    return json({ ok: true, recovery_code: recovery });
  } catch (e) {
    console.error("reset-with-recovery", e);
    return fail("Zurücksetzen fehlgeschlagen. Bitte später erneut versuchen.", 500);
  }
});
