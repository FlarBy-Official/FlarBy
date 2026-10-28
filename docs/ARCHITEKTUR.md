# FlarChat – Architektur-Vertrag (verbindlich für alle)

App-Name **FlarChat**, UI komplett **Deutsch**. WhatsApp-Look in Rot (`--red:#FF2800`, `--red-dark:#D40000`), Hell- und Dunkelmodus.
Frontend: reines HTML/CSS/JS (ES-Module, **kein Build, kein npm, kein React/TS**), gehostet auf GitHub Pages (Repo-Root).
Backend: Supabase (Postgres+RLS, Auth, Realtime, Storage, Edge Functions/Deno). < 50 Nutzer.
Supabase-Client per CDN: `https://esm.sh/@supabase/supabase-js@2`. Öffentliche Signups in Supabase sind AUS.

## Login
Benutzername -> Pseudo-E-Mail `<username-lowercase>@flarchat.local`. Benutzername: `^[a-z0-9_]{3,20}$` (Anzeige lowercase).
Registrierung nur per Code über Edge Function `register`. Die lokale App-PIN (4–6 Ziffern, freiwillig) liegt nur im Gerät (localStorage, gesalzener SHA-256), reine App-Sperre.

## Tabellen (schema `public`) – Besitzer: SQL-Agent
- `profiles`(id uuid pk = auth.users.id, username text unique, display_name text, avatar_url text, global_role text default 'user' check in ('user','moderator','admin','owner'), team_tag_visible bool default true, verified bool default false, verified_visible bool default true, muted_until timestamptz, banned bool default false, must_change_password bool default false, last_seen timestamptz, created_at timestamptz default now())
- `profile_secrets`(user_id pk, recovery_hash text) – KEINE Policies (nur service role / security definer)
- `chats`(id uuid pk, type text check in ('direct','group'), name text, avatar_url text, verified bool default false, created_by uuid, created_at, pinned_message_id uuid null)
- `chat_roles`(id uuid pk, chat_id, name text, color text, is_system bool, system_key text null check in ('owner','admin','member'), permissions jsonb, position int)
- `chat_members`(chat_id, user_id, role_id null für direct, joined_at, last_read_at timestamptz, pk(chat_id,user_id))
- `messages`(id uuid pk, chat_id, sender_id, body text, media_path text null, reply_to uuid null, created_at, edited_at null, deleted_at null, deleted_by null)
- `message_edits`(id, message_id, old_body, edited_at)  – Historie, nur Admin-Bereich
- `reports`(id, message_id, chat_id, reporter_id, reason text, status text default 'open' check in ('open','resolved'), handled_by null, created_at)
- `invite_codes`(id, code text unique (12 Ziffern, Anzeige `1111-1111-1111`, gespeichert ohne Bindestriche), kind text check in ('chat','register'), chat_id null, created_by, created_at, expires_at, used_by null, used_at null, revoked bool default false)
- `tickets`(id, username text, message text, device_id text, status text default 'open' check in ('open','done'), created_at, handled_by null, handled_at null)
- `warnings`(id, user_id, by_user, reason, created_at)
- `audit_log`(id bigint, actor_id, action text, target text, details jsonb, created_at)
- `admin_pins`(user_id pk, pin_hash text (bcrypt via pgcrypto crypt), failed_attempts int default 0, locked_until null, unlocked_until null) – keine Policies
- `app_settings`(key text pk, value jsonb) – z.B. `group_creation_restricted` = false
- Storage-Bucket `media` (privat). Pfad `<chat_id>/<uuid>.jpg`. Lesen/Schreiben nur Chat-Mitglieder; Anzeige per signed URL.
- Realtime aktiviert für: messages, chat_members, chats, profiles (Typing/Presence läuft über Realtime Broadcast/Presence Channel `chat:<chat_id>`).

### Chat-Rechte (`chat_roles.permissions` jsonb, bool-Keys; neue Keys später einfach ergänzbar)
`send_messages, send_media, delete_others_messages, invite_members, remove_members, assign_roles, edit_chat_info, pin_messages, delete_chat, transfer_ownership, manage_roles`
- Systemrollen (Anlage bei Gruppenerstellung, nicht löschbar/umbenennbar): **owner** = alle true (nicht entziehbar), **admin** = alle außer `delete_chat`, `transfer_ownership`, **member** = `send_messages`, `send_media`.
- Eigene Rollen: nur mit Recht `manage_roles` (Owner hat es, kann es auch Rollen geben). Name + Farbe + Rechte.
- 1:1-Chats (`type='direct'`): keine Rollen, `role_id` null, beide dürfen senden.
- Globale Admins/Owner haben Chat-Rechte NICHT automatisch; sie lesen nicht mit (nur Owner über Admin-Bereich per PIN).
- Globale Rechte: moderator = Meldungen bearbeiten, Nachrichten löschen (nur gemeldete), verwarnen, stummschalten. admin = zusätzlich sperren, Registrier-/Chat-Codes erzeugen/reaktivieren, Tickets bearbeiten (Passwort zurücksetzen), Team-Bereich. owner = alles, globale Rollen vergeben, Verifizierungs-Badge vergeben, Admin-Lesebereich (PIN).

## RPC-Funktionen (security definer, `public`, Name = Vertrag) – Besitzer: SQL-Agent
Alle prüfen `auth.uid()` und Rechte serverseitig und werfen bei Fehler `raise exception` mit deutscher Meldung.
Chats/Nutzer: `create_group(p_name text) returns uuid` · `start_direct(p_user_id uuid) returns uuid` · `find_users(p_query text) returns setof profiles_public` · `leave_chat(p_chat_id)` · `delete_chat(p_chat_id)` · `mark_read(p_chat_id)` · `touch_presence()`
Gruppe: `update_chat(p_chat_id, p_name, p_avatar_url)` · `remove_member(p_chat_id, p_user_id)` · `set_member_role(p_chat_id, p_user_id, p_role_id)` · `create_role(p_chat_id, p_name, p_color, p_permissions jsonb) returns uuid` · `update_role(p_role_id, p_name, p_color, p_permissions jsonb)` · `delete_role(p_role_id)` (Mitglieder fallen auf member zurück) · `transfer_ownership(p_chat_id, p_user_id)` · `pin_message(p_chat_id, p_message_id)` (null = lösen)
Nachrichten: `edit_message(p_message_id, p_body)` (nur eigene, <= 3 Tage, schreibt `message_edits`) · `delete_message(p_message_id)` (eigene jederzeit; fremde nur mit `delete_others_messages`; setzt `deleted_at`, Soft-Delete) · Senden per direktem `insert` in `messages` (RLS prüft `send_messages`/`send_media`, Mute, Bann).
Codes: `create_chat_code(p_chat_id, p_hours int default 24) returns text` (Recht `invite_members`; liefert Code mit Bindestrichen) · `create_register_code(p_hours int default 24) returns text` (global admin/owner) · `redeem_chat_code(p_code text) returns uuid` (chat_id) · `revoke_code(p_code_id uuid)` · `list_codes(p_chat_id uuid default null)` · `reactivate_code(p_code_id)` erzeugt NEUEN Code gleicher Art (alter bleibt tot) und gibt ihn zurück. Codes: kryptografisch zufällig (`gen_random_bytes`), einmalig.
Moderation: `report_message(p_message_id, p_reason)` · `list_reports()` · `report_context(p_report_id) returns setof messages` (gemeldete + 5 davor + 5 danach; nur moderator+) · `resolve_report(p_report_id)` · `mod_delete_message(p_message_id)` · `warn_user(p_user_id, p_reason)` · `mute_user(p_user_id, p_hours int)` · `ban_user(p_user_id, p_banned bool)` (admin+)
Team/Owner: `set_global_role(p_user_id, p_role)` (owner) · `set_verified(p_kind text 'user'|'chat', p_id uuid, p_value bool)` (owner) · `set_my_team_tag_visible(p_value bool)` · `set_my_verified_visible(p_value bool)` · `list_users()` (moderator+) · `list_tickets()` · `close_ticket(p_ticket_id)` (admin+) · `submit_ticket(p_username, p_message, p_device_id) ` (für `anon` erlaubt; max 3 pro Stunde pro device_id und pro username) · `clear_must_change_password()` · `my_profile()`
Admin-Lesebereich (nur Owner): `admin_set_pin(p_old text, p_new text)` (erste PIN: `p_old` null erlaubt nur wenn noch keine existiert; PIN 8–12 Ziffern) · `admin_unlock(p_pin text) returns timestamptz` (bcrypt-Vergleich; 5 Fehlversuche -> 15 min Sperre; Erfolg -> 10 min `unlocked_until`; schreibt `audit_log`) · `admin_list_chats()` · `admin_chat_messages(p_chat_id, p_before timestamptz default now(), p_limit int default 100)` inkl. gelöschter + Bearbeitungshistorie als jsonb `edits` · `admin_audit_log(p_limit int default 200)`. Jeder Aufruf prüft `unlocked_until > now()` und schreibt `audit_log`.

`profiles_public` = View mit id, username, display_name, avatar_url, verified (nur wenn verified_visible), team_role (global_role nur wenn global_role<>'user' und team_tag_visible, sonst null), last_seen.
Standard-Datenbank-Sicht für Frontend: Chatliste per `select` auf `chat_members` mit Join auf `chats`, letzte Nachricht per View `chat_overview` (chat_id, name, type, avatar_url, verified, last_message_body, last_message_at, last_message_sender, unread_count, my_role_id, peer_user_id für direct).

Support-Tickets (028): `/ticket` im Chat-Eingabefeld öffnet nur beim Nutzer ein Fenster (nichts wird gesendet). Jedes Ticket ist ein Chat mit `chats.type='ticket'` (Name „Ticket [Anzeigename] #0001“, fortlaufend für alle), Mitglieder = Nutzer + alle Teamler (moderator/admin/owner), Tabelle `support_tickets`(id, number, chat_id, user_id, reason, status 'open'|'closed', closed_by, closed_at, user_deleted_at; höchstens ein nicht gelöschtes Ticket pro Nutzer). Im Ticket nur Text, Bilder, Antworten, Erwähnungen; keine Reaktionen, Umfragen, Sprachnachrichten, Weiterleiten, Melden; Stummschaltung gilt. `my_support_ticket()` · `open_support_ticket(p_category, p_text) returns uuid` · `close_support_ticket(p_chat_id)` (moderator+; schreibt Systemzeile, wirft alle Teamler aus dem Chat, Chat wird nur lesbar) · `delete_my_support_ticket(p_chat_id)` (nur geschlossen; nur beim Nutzer weg) · `admin_list_support_tickets()` (Owner, Admin-Panel-Tab „Support“, liest auch geschlossene/gelöschte Tickets). Neue Teamler werden per Trigger in offene Tickets aufgenommen, ehemalige entfernt.

## Edge Functions (Deno, `supabase/functions/<name>/index.ts`) – Besitzer: Edge-Agent
CORS offen für Aufrufe aus dem Browser. Service-Key nur aus `Deno.env`.
- `register` POST `{username, password, code}` -> prüft Code (kind 'register' oder 'chat'), legt Auth-User (E-Mail bestätigt) + profile an (erster Nutzer überhaupt wird `owner`), markiert Code verbraucht, bei Chat-Code Beitritt als `member`, erzeugt Wiederherstellungscode `XXXX-XXXX` (Hash in `profile_secrets`) -> `{ok:true, recovery_code}`. Passwort >= 8 Zeichen. Fehler `{ok:false, error:"<deutsch>"}`.
- `reset-with-recovery` POST `{username, recovery_code, new_password}` -> setzt Passwort, erzeugt neuen Recovery-Code -> `{ok, recovery_code}`.
- `admin-reset-password` POST (Authorization: Bearer <jwt eines admin/owner>) `{ticket_id, user_id}` -> temporäres Passwort (12 Zeichen, zufällig) setzen, `must_change_password=true`, Ticket schließen, `audit_log` -> `{ok, temp_password}`.
- `invalidate`: nicht nötig.

## Frontend-Dateien & Modul-Verträge
```
index.html          (C)  App-Shell: Login/Registrieren/Ticket, Chatliste, Chatansicht
admin.html          (D)  Owner-Admin-Bereich (PIN, Chats lesen, Audit)
manifest.json, sw.js, icons/ (C)
css/style.css       (C)  Basis-Design (WhatsApp-Layout in Rot, Variablen, Dark Mode)
css/features.css    (D)  Stile für features/*, admin.html
js/config.js        (fertig) SUPABASE_URL, SUPABASE_ANON_KEY
js/core.js          (fertig) sb, state, el(), esc(), toast(), openModal(), closeModal(), confirmDialog(), nameHtml(), fmtTime(), call()
js/app.js           (C)  Start, Router (Hash), Auth-Flow, Realtime
js/chatlist.js, js/chat.js, js/auth.js, js/pinlock.js, js/media.js (C)
js/features/chatInfo.js   (D)  export openChatInfo(chatId)   – Gruppeninfo, Mitglieder, Rollen zuweisen, entfernen, verlassen, löschen, Eigentum, Chat-Name/Bild, Badge-Anzeige
js/features/roles.js      (D)  export openRoles(chatId)     – eigene Rollen anlegen/ändern/löschen (Rechte-Schalter)
js/features/invite.js     (D)  export openInvite(chatId) (Code+QR erzeugen, Liste, widerrufen, reaktivieren, Direkteinladung per Benutzername) · export openJoin() (Code eintippen oder QR scannen via BarcodeDetector, Fallback jsQR per CDN)
js/features/team.js       (D)  export openTeamPanel()       – je nach globaler Rolle: Meldungen (Kontext, löschen, verwarnen, stumm), Tickets (Passwort-Reset), Nutzerliste (Rolle, Badge, Sperre), Registrier-Codes
js/features/report.js     (D)  export openReport(messageId)
js/features/settings.js   (C)  export openSettings() – Profil, Team-Tag/Badge an/aus, App-PIN, Passwort ändern, Dark Mode, Abmelden
```
C ruft D-Module per dynamischem `import()` auf, nur über die Exporte oben. D ruft nur `core.js`-Helfer und Supabase-RPC. Texte immer Deutsch, kein Inline-`innerHTML` mit Nutzerdaten ohne `esc()`.

### Registrierung (C)
Pflicht-Haken „Ich habe die AGB gelesen“ mit Link zu `agb.html`.

### Sicherheit (alle)
Keine Secrets im Repo. Nur `anon`-Key im Frontend. RLS überall aktiv; sensible Tabellen ohne Policies. Admin-PIN nie im Code.
