# Regeln für KI-Helfer (FlarChat)

## Wie du mit dem Besitzer sprichst
- Der Besitzer ist 11 Jahre alt. Schreibe auf Deutsch, mit kurzen und einfachen Sätzen.
- Keine schweren Wörter. Wenn ein schweres Wort nötig ist, erkläre es in einem Satz.
- Sage immer, was du gemacht hast und was er jetzt tun muss.

## Wichtige Daten
- Code-Seite (GitHub): https://github.com/FlarBy-Official/FlarBy (Konto `FlarBy-Official`, Zweig `main`)
- Die fertige App: https://flarby-official.github.io/FlarBy/
- Supabase-Projekt (Datenbank): `vrofsgvzjjjrltixjaqd`
- In `js/config.js` steht nur der öffentliche Schlüssel (`sb_publishable_...`). Der Schlüssel `service_role` und die Admin-PIN dürfen NIE in eine Datei oder in den Chat.

## So funktioniert das Deployment (Veröffentlichen)

Es gibt 3 Teile. Jeder Teil wird anders veröffentlicht.

### 1. App-Dateien (HTML, CSS, JS) – AUTOMATISCH
GitHub Pages stellt alles aus dem Zweig `main` online. Es reicht, die Dateien zu **pushen** (hochzuladen):

```bash
cd /Users/michael.sonnleitner2/dev/repos/bela/familienchat
git add -A
git commit -m "Was wurde geändert"
git push
```

Nach 1–2 Minuten ist die neue Version online.
Wenn sich Dateien der App ändern, erhöhe in `sw.js` die Zahl bei `flarchat-shell-vN` um 1. Sonst zeigt der Browser noch die alte Version.

### 2. Edge Functions (Ordner `supabase/functions`) – mit einem Befehl
Das sind kleine Programme auf dem Supabase-Server (Registrieren, Passwort-Reset). Wenn sich dort etwas ändert, musst du sie extra hochladen:

```bash
cd /Users/michael.sonnleitner2/dev/repos/bela/familienchat
npx supabase functions deploy register reset-with-recovery admin-reset-password --project-ref vrofsgvzjjjrltixjaqd
```

Dafür braucht man einen Zugangs-Token von Supabase (https://supabase.com/dashboard/account/tokens). Er wird vorher im Terminal gesetzt und nie in den Chat geschrieben:

```bash
export SUPABASE_ACCESS_TOKEN=DEIN_TOKEN
```

Prüfen, ob es klappt: Diese Adresse darf NICHT „not found“ (404) sagen:
`https://vrofsgvzjjjrltixjaqd.supabase.co/functions/v1/register`

### 3. Datenbank (Ordner `supabase/migrations`) – von Hand
- Alte SQL-Dateien (`001` bis `005`) werden NIE geändert, sie sind schon eingespielt.
- Neue Änderungen kommen in eine **neue Datei** mit der nächsten Nummer (z. B. `006_name.sql`).
- Der Besitzer öffnet Supabase > **SQL Editor**, fügt den Inhalt der neuen Datei ein und drückt **Run**.

## Pflicht für jeden KI-Helfer: IMMER automatisch veröffentlichen
Nach **jeder** Änderung am Projekt, ohne dass der Besitzer extra fragen muss:
1. Prüfe die Dateien (Syntax-Check, z. B. `node --check` für JS).
2. Mache `git add -A`, `git commit` und `git push` (Teil 1). Das ist immer erlaubt.
3. Wenn `supabase/functions` geändert wurde: Führe den Deploy-Befehl aus Teil 2 aus. Fehlt der Token, sage dem Besitzer in einfachen Worten, dass er ihn im Terminal setzen und den Befehl selbst ausführen soll.
4. Wenn `supabase/migrations` geändert wurde: Sage dem Besitzer deutlich, dass er die neue Datei im SQL Editor ausführen muss (Teil 3).
5. Sage am Ende in einfachen Worten, was jetzt online ist und was noch zu tun ist.

Commit-Text endet mit:
`Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

## Wichtige Regeln fürs Projekt
- Nur reines HTML, CSS und JS (kein React, kein npm-Build). Alle Texte auf Deutsch.
- Der Vertrag für Datenbank und Funktionen steht in `docs/ARCHITEKTUR.md`. Halte dich daran.
- Die Einrichtung steht in `docs/EINRICHTUNG.md`, die Testliste in `docs/TESTEN.md`.
