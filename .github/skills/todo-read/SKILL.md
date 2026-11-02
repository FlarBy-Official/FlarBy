---
name: todo-read
description: Arbeitet das Auftragsbuch TODO.md ab. Nutze es, wenn der Besitzer "/todo-read" oder "todo-read" schreibt.
---

# todo-read

Der Besitzer schreibt Aufträge in `TODO.md` (eine Zeile pro Auftrag) und setzt `/do` darunter.

## Ablauf
1. Lies `TODO.md` ganz.
2. Finde den neuen Block: alles nach dem letzten `/do [Fertig]` bis zum nächsten `/do`.
   - Steht am Ende kein `/do` ohne `[Fertig]`, ist alles Entwurf. Mache nichts und sage es dem Besitzer.
   - Zeilen ohne `/do` danach ignorierst du.
3. Mache die Zeilen **von oben nach unten, eine nach der anderen**. Zeilen, die schon `[Fertig]` oder `[Frage: …]` tragen, überspringst du. Hat der Besitzer eine Zeile mit `[Frage: …]` geändert und ein neues `/do` gesetzt, versuche sie neu.
4. Nach **jeder** Zeile:
   - Prüfe die Dateien (z. B. `node --check` für JS).
   - Erhöhe in `sw.js` die Zahl bei `flarchat-shell-vN` um 1, wenn sich App-Dateien geändert haben.
   - Schreibe `[Fertig]` hinter die Zeile in `TODO.md`.
   - `git add -A`, `git commit`, `git push`. Der Commit-Text endet mit `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
   - Wenn `supabase/functions` geändert wurde: Deploy-Befehl aus `AGENTS.md` ausführen. Fehlt der Token, sage dem Besitzer, dass er ihn selbst im Terminal setzen muss.
   - Wenn `supabase/migrations` geändert wurde: Sage deutlich, dass er die neue Datei im SQL Editor ausführen muss.
5. Ist eine Zeile unklar: Schreibe `[Frage: …]` dahinter und mache mit der nächsten weiter.
6. Am Ende: Ändere `/do` zu `/do [Fertig]` und pushe `TODO.md`.

## Skills in Zeilen
Steht in einer Zeile ein Skill, führst du ihn selbst aus (Regeln in `AGENTS.md`, Abschnitt „Skills in `TODO.md`“):
- `/grilling` oder `/grill-me`: Skill `grilling` aufrufen und dem Besitzer sofort die Fragen stellen. `[Fertig]`, wenn alles beantwortet ist.
- `/diagnosing-bugs`, `/tdd`, `/code-review`: den gleichnamigen Skill mit dem Text der Zeile aufrufen.
- `/new`: alles pushen, `[Fertig]` setzen, 2–3 Sätze Zusammenfassung unter die Zeile schreiben, dann aufhören und dem Besitzer sagen, dass er `/new` im Terminal tippen soll.

## Antwort an den Besitzer
Er ist 11 Jahre alt. Schreibe auf Deutsch, kurz und einfach. Sage, was fertig ist, welche Fragen offen sind und was er noch tun muss. Der Schlüssel `service_role` darf nie in eine Datei oder in den Chat.
