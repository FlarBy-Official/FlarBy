import { corsHeaders } from "../_shared/cors.ts";
import {
  adminClient,
  fail,
  generateTempPassword,
  json,
  readBody,
} from "../_shared/util.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return fail("Methode nicht erlaubt.", 405);

  try {
    const token = (req.headers.get("Authorization") ?? "")
      .replace(/^Bearer\s+/i, "").trim();
    if (!token) return fail("Nicht angemeldet.", 401);

    const db = adminClient();
    const { data: auth, error: authErr } = await db.auth.getUser(token);
    if (authErr || !auth?.user) return fail("Nicht angemeldet.", 401);
    const actorId = auth.user.id;

    const { data: actor } = await db
      .from("profiles")
      .select("global_role, banned")
      .eq("id", actorId)
      .maybeSingle();
    if (
      !actor || actor.banned ||
      !["admin", "owner"].includes(actor.global_role)
    ) {
      return fail("Keine Berechtigung.", 403);
    }

    const body = await readBody(req);
    const ticketId = body?.ticket_id;
    const userId = body?.user_id;
    if (typeof userId !== "string" || !UUID_RE.test(userId)) {
      return fail("Ungültige Anfrage.");
    }
    if (
      ticketId != null && ticketId !== "" &&
      (typeof ticketId !== "string" && typeof ticketId !== "number")
    ) {
      return fail("Ungültige Anfrage.");
    }

    const { data: target } = await db
      .from("profiles")
      .select("id, username, global_role")
      .eq("id", userId)
      .maybeSingle();
    if (!target) return fail("Nutzer nicht gefunden.", 404);
    const rank: Record<string, number> = { user: 0, moderator: 1, admin: 2, owner: 3 };
    if (
      actor.global_role !== "owner" && target.id !== actorId &&
      (rank[target.global_role] ?? 0) >= (rank[actor.global_role] ?? 0)
    ) {
      return fail("Keine Berechtigung.", 403);
    }

    const tempPassword = generateTempPassword();
    const { error: pwErr } = await db.auth.admin.updateUserById(userId, {
      password: tempPassword,
    });
    if (pwErr) throw pwErr;

    const { error: pErr } = await db.from("profiles")
      .update({ must_change_password: true })
      .eq("id", userId);
    if (pErr) throw pErr;

    if (ticketId != null && ticketId !== "") {
      await db.from("tickets")
        .update({
          status: "done",
          handled_by: actorId,
          handled_at: new Date().toISOString(),
        })
        .eq("id", ticketId);
    }

    await db.from("audit_log").insert({
      actor_id: actorId,
      action: "admin_reset_password",
      target: userId,
      details: { ticket_id: ticketId ?? null, username: target.username },
    });

    return json({ ok: true, temp_password: tempPassword });
  } catch (e) {
    console.error("admin-reset-password", e);
    return fail("Zurücksetzen fehlgeschlagen. Bitte später erneut versuchen.", 500);
  }
});
