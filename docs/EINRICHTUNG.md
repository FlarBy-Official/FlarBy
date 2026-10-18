# FlarChat einrichten – Schritt für Schritt

Diese Anleitung ist für Einsteiger. Du brauchst etwa 45 Minuten. Alles ist kostenlos.

Du brauchst zwei Dienste:
- **GitHub** speichert den Code und zeigt die Webseite an (GitHub Pages).
- **Supabase** speichert die Chats und kümmert sich um den Login.

---

## 1. GitHub-Konto und Repository anlegen

1. Öffne <https://github.com> und klicke auf **Sign up**. Lege ein Konto an.
2. Klicke oben rechts auf **+** und dann auf **New repository**.
3. Name: zum Beispiel `flarchat`.
4. Wähle **Public** (öffentlich).
   - **Warum?** GitHub Pages ist bei kostenlosen Konten nur für öffentliche Repos verfügbar.
   - **Wichtig:** Jeder kann den Code sehen. Darum dürfen **keine Geheimnisse** hinein: keine Passwörter, keine PIN, kein `service_role`-Key. Der `anon`-Key ist dafür gemacht, öffentlich zu sein.
   - Mit einem bezahlten Konto darfst du **Private** wählen.
5. Klicke auf **Create repository**.

## 2. Code hochladen

**Variante A: mit Git (Terminal)**

1. Öffne ein Terminal im Projektordner `familienchat`.
2. Führe der Reihe nach aus (ersetze `DEINNAME`):

```bash
git init
git add .
git commit -m "FlarChat"
git branch -M main
git remote add origin https://github.com/DEINNAME/flarchat.git
git push -u origin main
```

3. Beim Push fragt GitHub nach deinen Daten. Als Passwort brauchst du einen **Personal Access Token** (GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Haken bei `repo`).

**Variante B: ohne Git (Web-Upload)**

1. Öffne dein Repo auf GitHub und klicke auf **uploading an existing file**.
2. Ziehe alle Dateien und Ordner aus `familienchat` in das Fenster.
3. Die versteckte Datei `.nojekyll` muss mit hinein. Lege sie sonst über **Add file → Create new file** an (leer).
4. Klicke auf **Commit changes**.

> Tipp: Mache Schritt 9 (config.js füllen) **vor** dem Hochladen oder lade die Datei danach neu hoch.

## 3. GitHub Pages aktivieren

1. Im Repo: **Settings** → links **Pages**.
2. Bei **Source** wähle **Deploy from a branch**.
3. Branch: **main**, Ordner: **/ (root)**. Klicke auf **Save**.
4. Warte 1–2 Minuten. Oben steht dann deine Adresse, zum Beispiel `https://deinname.github.io/flarchat/`. **Merke sie dir.**

## 4. Supabase-Projekt anlegen

1. Öffne <https://supabase.com> und klicke auf **Start your project**. Melde dich an (zum Beispiel mit GitHub).
2. Klicke auf **New project**.
3. Name: `flarchat`.
4. Vergib ein **Database Password**. Speichere es in einem Passwort-Manager. Es kommt nicht in den Code.
5. **Region:** wähle **Central EU (Frankfurt)**.
6. Plan: **Free**. Klicke auf **Create new project**. Warte einige Minuten.

## 5. Datenbank einrichten (SQL-Dateien)

1. In Supabase links auf **SQL Editor** klicken.
2. Klicke auf **New query**.
3. Öffne auf deinem Computer die Datei `supabase/migrations/001_….sql`, kopiere den ganzen Inhalt, füge ihn ein und klicke auf **Run**.
4. Es muss **Success** erscheinen.
5. Wiederhole das **der Reihe nach** für `002`, `003`, `004` und `005`. Überspringe keine Datei.
6. Bei einem Fehler: nicht weitermachen. Siehe „Häufige Probleme“.

## 6. Login-Einstellungen (Auth)

1. Links **Authentication** → **Sign In / Providers** (oder **Providers**).
2. Öffne **Email**. Schalte **Confirm email** **aus**.
3. Suche die Option **Allow new users to sign up** (in **Authentication → Sign In / Providers**, Abschnitt „User Signups“) und schalte sie **aus**. Neue Nutzer kommen nur über Registrierungscodes hinein.
4. Speichere.

## 7. Edge Functions bereitstellen

Edge Functions sind kleine Programme auf dem Supabase-Server. Sie erledigen Registrierung und Passwort-Reset.

1. Installiere **Node.js** von <https://nodejs.org> (LTS-Version).
2. Öffne ein Terminal und installiere das Supabase-Werkzeug:

```bash
npm i -g supabase
```

3. Melde dich an (ein Browser öffnet sich):

```bash
supabase login
```

4. Wechsle in den Projektordner und verbinde das Projekt. Die **Project-Ref** findest du in Supabase unter **Project Settings → General** (Reference ID):

```bash
cd familienchat
supabase link --project-ref DEINE_PROJECT_REF
```

5. Stelle die drei Funktionen bereit:

```bash
supabase functions deploy register reset-with-recovery admin-reset-password
```

6. Secrets musst du **nicht** setzen. `SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` stehen in Edge Functions automatisch zur Verfügung.
7. Falls Supabase nach der JWT-Prüfung fragt: `register` und `reset-with-recovery` werden von ausgeloggten Nutzern aufgerufen. Folge dafür den Hinweisen im Ordner `supabase/functions` (die `supabase/config.toml` stellt das ein; falls es trotzdem „401“ gibt, deploye mit `supabase functions deploy register --no-verify-jwt` und ebenso `reset-with-recovery`).

## 8. js/config.js ausfüllen

1. In Supabase: **Project Settings → API** (oder **API Keys**).
2. Kopiere die **Project URL** (sieht aus wie `https://abcdefgh.supabase.co`).
3. Kopiere den Key **anon / public**.
4. Öffne `js/config.js` und trage beides ein.
5. **Nie** den Key `service_role` verwenden! Der gibt vollen Zugriff auf alles.
6. Lade die Datei auf GitHub hoch (`git add . && git commit -m "config" && git push`, oder im Web ersetzen).

## 9. Site-URL und Redirect setzen

1. In Supabase: **Authentication → URL Configuration**.
2. **Site URL:** deine Pages-Adresse, zum Beispiel `https://deinname.github.io/flarchat/`.
3. Bei **Redirect URLs** dieselbe Adresse hinzufügen.
4. Speichern.

## 10. Ersten Nutzer registrieren (wird Owner)

1. Öffne deine Pages-Adresse.
2. Der **allererste** Nutzer wird automatisch **Owner** (Besitzer mit allen Rechten). Dafür brauchst du **keinen** Code. Lass das Code-Feld leer. Falls die App trotzdem einen Code verlangt, siehe „Häufige Probleme“.
3. Wähle Benutzernamen (3–20 Zeichen: a–z, Ziffern, Unterstrich) und ein Passwort (mindestens 8 Zeichen).
4. **Wichtig:** Es erscheint ein **Wiederherstellungscode** (`XXXX-XXXX`). Schreibe ihn auf Papier. Er hilft, wenn du dein Passwort vergisst.

## 11. Eigene Admin-PIN setzen

Der Admin-Bereich (`admin.html`) ist durch eine PIN geschützt. Du legst sie selbst fest.

1. Melde dich als Owner in FlarChat an und öffne `admin.html` (Menü > Admin-Bereich).
2. Öffne „PIN setzen / ändern“, lasse „Alte PIN“ leer und gib eine neue PIN mit 8–12 Ziffern ein.
3. **Schreibe die PIN nirgends ins Repo, in Dateien auf GitHub oder in einen Chat.**
4. **Eine PIN, die schon einmal im Chatverlauf (beim Entwickeln) genannt wurde, darfst du NICHT verwenden.** Sie gilt als bekannt. Wähle eine neue.
5. Später ändern: im selben Formular alte und neue PIN eingeben.

## 12. Registrierungscodes erzeugen und Freunde einladen

1. Melde dich in FlarChat an.
2. Öffne den **Team-Bereich** und dort **Registrierungs-Codes**.
3. Klicke auf **Neuen Code erzeugen**. Der Code hat 12 Ziffern, zum Beispiel `1111-1111-1111`.
4. Schicke den Code und die Adresse der App an deinen Freund. **Jeder Code gilt nur einmal** und läuft nach einer Zeit ab.
5. Dein Freund öffnet die Adresse, wählt „Registrieren“ und gibt Code, Benutzername und Passwort ein.
6. Gruppen-Einladungen: in der Gruppe auf **Einladen** gehen. Dort gibt es Chat-Codes und QR-Codes.

## 13. App auf dem Handy installieren (PWA)

- **iPhone (Safari):** Seite öffnen → Teilen-Symbol → **Zum Home-Bildschirm**.
- **Android (Chrome):** Seite öffnen → Menü (drei Punkte) → **App installieren** oder **Zum Startbildschirm hinzufügen**.

Danach startet FlarChat wie eine normale App.

---

## Rollen und Berechtigungen (Kurzüberblick)

**Globale Rollen (für die ganze App):**

| Rolle | Darf |
|---|---|
| Nutzer | chatten |
| Moderator | Meldungen bearbeiten, gemeldete Nachrichten löschen, verwarnen, stummschalten |
| Admin | zusätzlich sperren, Codes erzeugen, Tickets bearbeiten (Passwort zurücksetzen) |
| Owner | alles, Rollen vergeben, Verifiziert-Haken vergeben, Admin-Lesebereich (mit PIN) |

**Gruppenrollen (nur in einer Gruppe):**

- **Owner:** alle Rechte, kann die Gruppe löschen und übergeben.
- **Admin:** fast alle Rechte, außer Löschen und Übergeben.
- **Member:** schreiben und Bilder senden.
- Eigene Rollen mit frei wählbaren Rechten sind möglich.

Globale Admins lesen **nicht automatisch** in Gruppen mit.

## Datenschutz & Mitlesen

- Der Owner kann über den geschützten Admin-Bereich Chats lesen. Das gilt auch für gelöschte und bearbeitete Nachrichten.
- Alle Nutzer werden **offen darüber informiert**: bei der Registrierung (großer Hinweis) und in den Einstellungen.
- Der Zugang ist nur mit der Admin-PIN möglich. Nach 5 falschen Eingaben ist er 15 Minuten gesperrt. Nach dem Entsperren bleibt er 10 Minuten offen.
- **Jeder Zugriff wird im Protokoll (Audit-Log) gespeichert.**
- Nutze den Zugang nur, wenn es nötig ist, zum Beispiel bei Meldungen. Sage deinen Freunden und deiner Familie ehrlich, dass es ihn gibt.

## Passwort vergessen

Es gibt drei Wege:

1. **Wiederherstellungscode:** Auf der Login-Seite „Passwort vergessen“ wählen. Benutzername, Wiederherstellungscode (`XXXX-XXXX`) und neues Passwort eingeben. Danach gibt es einen **neuen** Code. Bitte wieder aufschreiben.
2. **Ticket:** Ohne Code kann man eine Anfrage (Ticket) an das Team senden. Es sind höchstens 3 Tickets pro Stunde möglich.
3. **Temporäres Passwort:** Ein Admin bearbeitet das Ticket und erzeugt ein Passwort aus 12 Zeichen. Gib es der Person auf sicherem Weg weiter. Beim nächsten Login muss sie ein neues Passwort wählen.

## Häufige Probleme (FAQ)

**Die Seite ist leer oder zeigt 404.**
Pages braucht 1–2 Minuten. Prüfe in **Settings → Pages**, ob Branch `main` und `/ (root)` gewählt sind. Die Datei `index.html` muss im Hauptordner liegen.

**„Failed to fetch“ oder Fehler beim Registrieren.**
Prüfe `js/config.js` (URL und anon-Key). Prüfe, ob die drei Edge Functions bereitgestellt sind (Supabase → Edge Functions).

**Fehler beim Ausführen einer SQL-Datei.**
Führe die Dateien genau in der Reihenfolge 001 bis 005 aus. Jede nur einmal. Lies die Fehlermeldung. Wenn nichts hilft, setze das Projekt neu auf (neues Supabase-Projekt) und beginne bei 001.

**„Code ungültig“.**
Codes gelten nur einmal und laufen ab. Erzeuge einen neuen Code.

**Ich habe alte Änderungen auf dem Handy, die App aktualisiert sich nicht.**
Schließe die App ganz und öffne sie neu. Sonst die Seite im Browser neu laden (Cache leeren) oder die App neu installieren.

**Admin-PIN gesperrt.**
Warte 15 Minuten.

**Ich habe die Admin-PIN vergessen.**
Im SQL Editor `delete from admin_pins;` ausführen und danach in `admin.html` eine neue PIN setzen.

**Wie viele Nutzer gehen?**
FlarChat ist für unter 50 Nutzer gedacht. Der kostenlose Supabase-Plan reicht dafür. Er pausiert Projekte nach längerer Inaktivität. Öffne dann das Supabase-Dashboard und klicke auf **Restore**.
