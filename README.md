# FlarChat

FlarChat ist ein privater Chat für Familie und Freunde. Er sieht aus wie WhatsApp, aber in Rot. Er läuft im Browser und lässt sich auf dem Handy wie eine App installieren (PWA).

Die ganze Oberfläche ist auf Deutsch. Es gibt einen Hell- und einen Dunkelmodus.

## Was kann FlarChat?

- Einzelchats und Gruppen
- Bilder senden
- Sprach- und Videoanrufe im Einzelchat und in Gruppen (bis 6 Personen, nur wenn die App offen ist)
- Antworten, Nachrichten bearbeiten (3 Tage lang) und löschen
- Gruppenrollen mit Rechten (Besitzer, Admin, Mitglied, eigene Rollen)
- Einladung per Code oder QR-Code
- Registrierung nur mit Code (keine offene Anmeldung)
- Nachrichten melden, Team-Bereich für Moderation
- Verwarnen, Stummschalten, Sperren
- Altersverifizierung ab 14 (Ausweis-Foto oder Elternteil bürgt, Prüfung durch das Team)
- Freiwillige App-PIN als Sperre auf dem Gerät
- „Passwort vergessen“ mit Wiederherstellungscode oder Ticket
- Support-Tickets: `/ticket` tippen, Grund angeben, Chat mit dem ganzen Team
- Ansage-Kanal „FlarChat Updates“: alle sind drin, nur Admins/Owner schreiben
- Geschützter Admin-Bereich für den Betreiber (nur für den Owner, mit Protokoll)

## Technik (kurz erklärt)

- **Frontend:** reines HTML, CSS und JavaScript. Kein Build, kein npm. Gehostet auf GitHub Pages.
- **Backend:** Supabase (Datenbank, Login, Echtzeit, Bilder-Speicher, Edge Functions).

## Projektstruktur

```
index.html, admin.html   Seiten der App
manifest.json, sw.js     Installation als App
css/                     Design
js/                      Programmcode (config.js = deine Supabase-Daten)
supabase/migrations/     SQL-Dateien (Datenbank)
supabase/functions/      Edge Functions (Registrierung, Passwort-Reset)
docs/                    Anleitungen
```

## Los geht's

Die Schritt-für-Schritt-Anleitung für Einsteiger steht in
[docs/EINRICHTUNG.md](docs/EINRICHTUNG.md).
Die Altersprüfung ist in [docs/ALTERSPRUEFUNG.md](docs/ALTERSPRUEFUNG.md) erklärt.
Eine Test-Checkliste steht in [docs/TESTEN.md](docs/TESTEN.md).
Der technische Aufbau steht in [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).

## Wichtig zur Sicherheit

Das Repo ist bei GitHub Pages (kostenlos) öffentlich. Lege deshalb **nie** Passwörter, PINs oder den `service_role`-Key in den Code. In `js/config.js` gehört nur der öffentliche `anon`-Key.
