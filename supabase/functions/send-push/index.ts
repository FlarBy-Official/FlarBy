import webpush from "npm:web-push@3";
import { adminClient, fail, json, readBody } from "../_shared/util.ts";

// Aufruf nur mit Header x-push-secret (= Secret PUSH_WEBHOOK_SECRET).
// Body: {type:"message", message_id} oder {type:"reminders"}

const PRESENCE_SECONDS = 90;
const MENTION_RE = /@[\p{L}\p{N}_]+/gu;
const AUDIO_RE = /\.(webm|m4a|mp4|ogg)$/i;

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
type Payload = { title: string; body: string; chat_id: string; tag: string; kind: string };

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function clip(t: string, n = 100): string {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function mediaText(path: string): string {
  return AUDIO_RE.test(path) ? "🎤 Sprachnachricht" : "📷 Bild";
}

// deno-lint-ignore no-explicit-any
type DB = any;

async function sendTo(db: DB, userId: string, payload: Payload) {
  const { data: subs } = await db.from("push_subscriptions")
    .select("id,endpoint,p256dh,auth").eq("user_id", userId);
  let sent = 0;
  for (const s of (subs ?? []) as Sub[]) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await db.from("push_subscriptions").delete().eq("id", s.id);
      } else {
        console.error("push fehlgeschlagen", code);
      }
    }
  }
  return sent;
}

function recentlyActive(lastSeen: string | null | undefined): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < PRESENCE_SECONDS * 1000;
}

async function handleMessage(db: DB, messageId: string) {
  const { data: msg } = await db.from("messages")
    .select("id,chat_id,sender_id,body,media_path,deleted_at").eq("id", messageId).maybeSingle();
  if (!msg || msg.deleted_at) return { sent: 0 };

  const [{ data: chat }, { data: sender }, { data: members }] = await Promise.all([
    db.from("chats").select("id,type,name").eq("id", msg.chat_id).maybeSingle(),
    db.from("profiles").select("display_name,username").eq("id", msg.sender_id).maybeSingle(),
    db.from("chat_members").select("user_id,role_id").eq("chat_id", msg.chat_id).neq("user_id", msg.sender_id),
  ]);
  if (!chat) return { sent: 0 };
  const senderName: string = sender?.display_name || sender?.username || "Jemand";
  const recipients = (members ?? []) as { user_id: string; role_id: string | null }[];
  if (!recipients.length) return { sent: 0 };
  const ids = recipients.map((r) => r.user_id);

  const [{ data: profs }, { data: prefs }, { data: muted }, { data: subRows }, { data: roles }] = await Promise.all([
    db.from("profiles").select("id,username,banned,last_seen,status_key,status_until").in("id", ids),
    db.from("push_prefs").select("user_id,show_text").in("user_id", ids),
    db.from("push_muted_chats").select("user_id").eq("chat_id", msg.chat_id).in("user_id", ids),
    db.from("push_subscriptions").select("user_id").in("user_id", ids),
    db.from("chat_roles").select("id,name").eq("chat_id", msg.chat_id),
  ]);
  const profBy = new Map((profs ?? []).map((p: { id: string }) => [p.id, p]));
  const showText = new Set((prefs ?? []).filter((p: { show_text: boolean }) => p.show_text).map((p: { user_id: string }) => p.user_id));
  const mutedSet = new Set((muted ?? []).map((m: { user_id: string }) => m.user_id));
  const hasSub = new Set((subRows ?? []).map((s: { user_id: string }) => s.user_id));
  const roleName = new Map((roles ?? []).map((r: { id: string; name: string }) => [r.id, String(r.name).toLowerCase().replace(/\s+/g, "")]));
  const mentions = ((msg.body ?? "") as string).toLowerCase().match(MENTION_RE) ?? [];

  const shownBody = ((msg.body ?? "") as string).replace(/\s*\/react\s*$/i, "");
  let content: string;
  if (msg.media_path && !shownBody.trim()) content = mediaText(msg.media_path);
  else if (shownBody) content = shownBody;
  else content = "📷 Bild";
  if (msg.media_path && shownBody.trim()) content = mediaText(msg.media_path) + " " + shownBody;

  let sent = 0;
  for (const r of recipients) {
    if (!hasSub.has(r.user_id)) continue;
    const p = profBy.get(r.user_id) as { username: string; banned: boolean; last_seen: string | null; status_key: string | null; status_until: string | null } | undefined;
    if (!p || p.banned || recentlyActive(p.last_seen)) continue;
    // "Bitte nicht stören": gar keine Mitteilung, auch nicht bei @Erwähnung
    if (p.status_key === "dnd" && (!p.status_until || new Date(p.status_until) > new Date())) continue;
    if (mutedSet.has(r.user_id)) {
      const mine = new Set(["@everyone", "@" + p.username.toLowerCase()]);
      const rn = r.role_id ? roleName.get(r.role_id) : null;
      if (rn) mine.add("@" + rn);
      if (!mentions.some((m: string) => mine.has(m))) continue;
    }
    let body: string;
    if (showText.has(r.user_id)) body = `${senderName}: ${clip(content)}`;
    else if (chat.type === "channel") body = `📢 ${chat.name}: neue Nachricht`;
    else if (chat.type === "group") body = `${chat.name}: neue Nachricht von ${senderName}`;
    else body = `Neue Nachricht von ${senderName}`;
    sent += await sendTo(db, r.user_id, {
      title: "FlarChat",
      body,
      chat_id: msg.chat_id,
      tag: msg.chat_id,
      kind: "message",
    });
  }
  return { sent };
}

async function handleReminders(db: DB) {
  const { data: due } = await db.from("reminders")
    .select("id,user_id,message_id,chat_id")
    .lte("remind_at", new Date().toISOString())
    .is("push_sent_at", null).is("delivered_at", null).limit(100);
  let sent = 0;
  for (const rem of (due ?? []) as { id: string; user_id: string; message_id: string | null; chat_id: string }[]) {
    const { data: p } = await db.from("profiles").select("banned,last_seen").eq("id", rem.user_id).maybeSingle();
    if (!p || p.banned) {
      await db.from("reminders").update({ push_sent_at: new Date().toISOString() }).eq("id", rem.id).is("push_sent_at", null);
      continue;
    }
    // Ist die App offen, zeigt sie die Erinnerung selbst
    if (recentlyActive(p.last_seen)) continue;
    // Nur einmal senden: wer die Zeile zuerst markiert, darf senden
    const { data: claimed } = await db.from("reminders")
      .update({ push_sent_at: new Date().toISOString() })
      .eq("id", rem.id).is("push_sent_at", null).select("id");
    if (!claimed?.length) continue;

    const { data: pref } = await db.from("push_prefs").select("show_text").eq("user_id", rem.user_id).maybeSingle();
    let body = "⏰ Erinnerung";
    if (pref?.show_text && rem.message_id) {
      const { data: m } = await db.from("messages").select("body,media_path,deleted_at").eq("id", rem.message_id).maybeSingle();
      if (m && !m.deleted_at) {
        const t = m.body?.trim() ? m.body : (m.media_path ? mediaText(m.media_path) : "");
        if (t) body = `⏰ Erinnerung: ${clip(t)}`;
      }
    }
    sent += await sendTo(db, rem.user_id, {
      title: "FlarChat",
      body,
      chat_id: rem.chat_id,
      tag: "rem-" + rem.id,
      kind: "reminder",
    });
  }
  return { sent };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail("Methode nicht erlaubt.", 405);
  const secret = Deno.env.get("PUSH_WEBHOOK_SECRET") ?? "";
  const given = req.headers.get("x-push-secret") ?? "";
  if (!secret || !safeEqual(secret, given)) return fail("Nicht erlaubt.", 401);

  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@flarchat.local";
  if (!pub || !priv) return fail("Push ist nicht eingerichtet.", 500);

  try {
    webpush.setVapidDetails(subject, pub, priv);
    const body = await readBody(req);
    if (!body) return fail("Ungültige Anfrage.");
    const db = adminClient();
    if (body.type === "message" && typeof body.message_id === "string") {
      return json({ ok: true, ...(await handleMessage(db, body.message_id)) });
    }
    if (body.type === "reminders") {
      return json({ ok: true, ...(await handleReminders(db)) });
    }
    return fail("Unbekannter Typ.");
  } catch (e) {
    console.error(e);
    return fail("Serverfehler.", 500);
  }
});
