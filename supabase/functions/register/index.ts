import { corsHeaders } from "../_shared/cors.ts";
import {
  adminClient,
  fail,
  generateRecoveryCode,
  hashRecovery,
  json,
  MIN_PASSWORD,
  normUsername,
  pseudoEmail,
  readBody,
  USERNAME_RE,
} from "../_shared/util.ts";

const CODE_ERROR = "Der Code ist ungültig, abgelaufen oder wurde bereits verwendet.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return fail("Methode nicht erlaubt.", 405);

  try {
    const body = await readBody(req);
    if (!body) return fail("Ungültige Anfrage.");

    const username = normUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    const code = typeof body.code === "string"
      ? body.code.replace(/\D/g, "")
      : "";

    if (!USERNAME_RE.test(username)) {
      return fail(
        "Benutzername: 3–20 Zeichen, nur Kleinbuchstaben, Ziffern und Unterstrich.",
      );
    }
    if (password.length < MIN_PASSWORD) {
      return fail(`Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen lang sein.`);
    }

    const db = adminClient();

    const { count: profileCount, error: cntErr } = await db
      .from("profiles")
      .select("id", { count: "exact", head: true });
    if (cntErr) throw cntErr;
    const isFirst = (profileCount ?? 0) === 0;

    if (!isFirst) {
      if (code.length !== 12) return fail(CODE_ERROR);
      const { data: c, error } = await db
        .from("invite_codes")
        .select("id")
        .eq("code", code)
        .is("used_at", null)
        .eq("revoked", false)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (error) throw error;
      if (!c) return fail(CODE_ERROR);
    }

    const { data: taken } = await db
      .from("profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();
    if (taken) return fail("Dieser Benutzername ist bereits vergeben.");

    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email: pseudoEmail(username),
      password,
      email_confirm: true,
      user_metadata: { username },
    });
    if (createErr || !created?.user) {
      const msg = (createErr?.message ?? "").toLowerCase();
      if (msg.includes("already") || msg.includes("registered")) {
        return fail("Dieser Benutzername ist bereits vergeben.");
      }
      throw createErr ?? new Error("createUser fehlgeschlagen");
    }
    const userId = created.user.id;

    const rollback = async (releaseCodeId?: string) => {
      if (releaseCodeId) {
        await db.from("invite_codes")
          .update({ used_by: null, used_at: null })
          .eq("id", releaseCodeId);
      }
      await db.from("profile_secrets").delete().eq("user_id", userId);
      await db.from("profiles").delete().eq("id", userId);
      await db.auth.admin.deleteUser(userId);
    };

    let claimedCodeId: string | undefined;
    try {
      const { error: pErr } = await db.from("profiles").upsert({
        id: userId,
        username,
        display_name: username,
        global_role: isFirst ? "owner" : "user",
      });
      if (pErr) throw pErr;

      if (isFirst) {
        // Gleichzeitige Erstregistrierung: nur der älteste Nutzer darf Owner bleiben.
        const { data: oldest } = await db
          .from("profiles")
          .select("id")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(1);
        if (oldest?.[0]?.id !== userId) {
          await rollback();
          return fail(CODE_ERROR);
        }
      } else {
        // Atomar verbrauchen: nur eine von mehreren parallelen Anfragen gewinnt.
        const { data: claimed, error: cErr } = await db
          .from("invite_codes")
          .update({ used_by: userId, used_at: new Date().toISOString() })
          .eq("code", code)
          .is("used_at", null)
          .eq("revoked", false)
          .gt("expires_at", new Date().toISOString())
          .select("id, kind, chat_id");
        if (cErr) throw cErr;
        if (!claimed || claimed.length !== 1) {
          await rollback();
          return fail(CODE_ERROR);
        }
        const row = claimed[0];
        claimedCodeId = row.id;

        if (row.kind === "chat") {
          const { data: role } = await db
            .from("chat_roles")
            .select("id")
            .eq("chat_id", row.chat_id)
            .eq("system_key", "member")
            .maybeSingle();
          if (!role) throw new Error("Systemrolle member fehlt");
          const { error: mErr } = await db.from("chat_members").insert({
            chat_id: row.chat_id,
            user_id: userId,
            role_id: role.id,
          });
          if (mErr) throw mErr;
        }
      }

      const recovery = generateRecoveryCode();
      const { error: sErr } = await db.from("profile_secrets").upsert({
        user_id: userId,
        recovery_hash: await hashRecovery(recovery.replace("-", "")),
      });
      if (sErr) throw sErr;

      return json({ ok: true, recovery_code: recovery });
    } catch (e) {
      console.error("register", e);
      await rollback(claimedCodeId);
      return fail("Registrierung fehlgeschlagen. Bitte später erneut versuchen.", 500);
    }
  } catch (e) {
    console.error("register", e);
    return fail("Registrierung fehlgeschlagen. Bitte später erneut versuchen.", 500);
  }
});
