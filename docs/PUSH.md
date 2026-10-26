# Handy-Mitteilungen (Push) einrichten

Damit bekommst du eine Mitteilung auf dem Handy, auch wenn die App zu ist.
Das gilt für neue Nachrichten und für Erinnerungen.

Du brauchst das nur **einmal**. Mach die Schritte der Reihe nach.

## Schritt 1: Schlüssel erzeugen
Im Terminal, im Projektordner:

```bash
npx web-push generate-vapid-keys
```

Du bekommst zwei Schlüssel: einen **Public Key** (öffentlich) und einen **Private Key** (geheim).
Den Private Key zeigst du NIEMANDEM. Nicht in den Chat, nicht in eine Datei.

## Schritt 2: Geheime Werte bei Supabase speichern
Erst den Zugangs-Token setzen (von https://supabase.com/dashboard/account/tokens):

```bash
export SUPABASE_ACCESS_TOKEN=DEIN_TOKEN
```

Dann die Secrets setzen. Denk dir ein langes geheimes Wort aus (DEIN_GEHEIMES_WORT):

```bash
npx supabase secrets set VAPID_PUBLIC_KEY=DEIN_PUBLIC_KEY VAPID_PRIVATE_KEY=DEIN_PRIVATE_KEY VAPID_SUBJECT=mailto:deine@mail.de PUSH_WEBHOOK_SECRET=DEIN_GEHEIMES_WORT --project-ref vrofsgvzjjjrltixjaqd
```

## Schritt 3: Funktion hochladen
```bash
npx supabase functions deploy send-push --project-ref vrofsgvzjjjrltixjaqd --no-verify-jwt
```

(`--no-verify-jwt` ist nötig. Die Funktion schützt sich selbst mit dem geheimen Wort.)

## Schritt 4: Datenbank einrichten
1. Öffne Supabase > **SQL Editor**.
2. Füge den Inhalt von `supabase/migrations/023_push.sql` ein und drücke **Run**.
   (Falls es wegen `pg_net` oder `pg_cron` meckert: Supabase > Database > Extensions, dort beide einschalten, dann nochmal **Run**.)
3. Jetzt das geheime Wort eintragen. Nimm genau dasselbe Wort wie in Schritt 2:

```sql
insert into public.push_config (key, value)
values ('webhook_secret', 'DEIN_GEHEIMES_WORT')
on conflict (key) do update set value = excluded.value;
```

Run drücken. Ab jetzt ruft die Datenbank bei jeder neuen Nachricht die Funktion auf und prüft jede Minute die Erinnerungen.

## Schritt 5: Öffentlichen Schlüssel in die App eintragen
Öffne `js/config.js`. Ersetze `REPLACE_WITH_VAPID_PUBLIC_KEY` durch deinen **Public Key**. Dann pushen (hochladen) wie immer.

## Schritt 6: Testen
1. **iPhone:** Öffne die App in Safari, tippe auf Teilen und dann **Zum Home-Bildschirm**. Starte die App vom Home-Bildschirm. (Nur so geht Push auf dem iPhone.)
2. Gehe in **Einstellungen > Mitteilungen** und schalte **Mitteilungen auf diesem Gerät** an. Erlaube die Frage.
3. Schließe die App ganz. Lass dir von einem anderen Gerät schreiben.
4. Nach ein paar Sekunden kommt die Mitteilung. Tippe darauf: Der Chat geht auf.

## Regeln, die gelten
- Keine Mitteilung für eigene Nachrichten.
- Keine Mitteilung, wenn die App gerade offen ist (weniger als 90 Sekunden aktiv).
- Stumme Chats senden nichts, außer jemand erwähnt dich (@name, @everyone oder deine @rolle).
- Mehrere Nachrichten aus einem Chat werden zusammengefasst („3 neue Nachrichten“).
- „Text in Mitteilung zeigen“ ist am Anfang aus. Dann steht nur, wer geschrieben hat.
- Erinnerungen brauchen die Tabelle `reminders` (Migration 021).

## Wenn etwas nicht geht
- Es passiert nichts Schlimmes. Die App zeigt Erinnerungen weiter selbst.
- Der Schalter sagt „Noch nicht eingerichtet“: Schritt 5 fehlt.
- Supabase > Edge Functions > send-push > Logs zeigt Fehler.
