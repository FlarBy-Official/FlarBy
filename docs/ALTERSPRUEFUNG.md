# Altersprüfung: Schritt für Schritt

FlarChat ist erst ab **14 Jahren**. Wer nicht geprüft ist, sieht nur ein Formular. Owner sind immer geprüft.

## A) Einmal einrichten (nur der Owner)

1. Öffne Supabase → **SQL Editor**.
2. Füge den Inhalt von `supabase/migrations/032_altersverifizierung.sql` ein und drücke **Run**.
3. Füge danach den Inhalt von `supabase/migrations/033_altersverifizierung_fix.sql` ein und drücke **Run**.
4. Öffne FlarChat und lade die Seite neu.
5. ⚠️ Ab jetzt sind **alle außer dir gesperrt**. Mache gleich Schritt B.

## B) Vertraute freischalten (Owner oder Admin)

1. Tippe oben auf **🎂 Alterprüfung** (im Menü ⋮ oder als großer Knopf).
2. Scrolle zu **Alle Nutzer**.
3. Tippe bei jeder vertrauten Person auf **Als geprüft markieren** und bestätige.
4. Für Eltern: Tippe als Owner auf **Elternteil**. Sie dürfen dann für bis zu 3 Personen bürgen.

## C) So prüft sich ein neuer oder gesperrter Nutzer

1. Er loggt sich ein und sieht **Alter bestätigen**.
2. Er trägt sein **Geburtsdatum** ein.
3. Er wählt einen Weg:
   - **Mit Ausweis-Foto:** Foto hochladen. Auf dem Ausweis alles abdecken außer Name, Geburtsdatum und Foto.
   - **Ein Elternteil bürgt:** Benutzername des Elternteils eintragen. Das Elternteil öffnet **⋮ → 👪 Bürgen-Anfragen** und tippt auf **Ich bürge**.
4. Er setzt das Häkchen beim Datenschutz-Text und tippt auf **Absenden**.
5. Er wartet in der Warteschlange. Die Seite schaut selbst nach. Wenn er geprüft ist, kommt er von allein in die App.

Unter 14: Er bekommt die Meldung „zu jung" und bleibt gesperrt, bis ein Admin ihn freischaltet.

## D) So prüft das Team

1. Öffne **🎂 Alterprüfung** (Mods über **🛡 Team-Bereich → Alter**).
2. Du siehst die **Warteschlange** mit Name, Geburtsdatum, Alter und Weg.
3. Tippe auf **Foto ansehen** und vergleiche Foto, Name und Geburtsdatum. Jeder Blick wird im Protokoll gespeichert.
4. **Mod:** Tippe auf **Vorprüfung: OK** oder **Vorprüfung: Nein** (mit Notiz).
5. **Admin oder Owner:** Tippe auf **Annehmen** oder **Ablehnen**. Beim Ablehnen schreibst du einen Grund. Die Person sieht ihn und kann neu einreichen.
6. Du kannst dich nie selbst prüfen. Dafür braucht es einen anderen Admin oder den Owner.

## E) Weitere Möglichkeiten (Admin oder Owner)

- **Wieder sperren:** Nimmt einer Person die Prüfung weg.
- **Geburtsdatum ändern:** Nur das Team kann das. Eingabe: `24.12.2012`.
- **Zu junge Person freischalten:** **Als geprüft markieren**.
- **Fotos & Datum löschen:** Nur der Owner. Das löscht alle Ausweis-Fotos und das Geburtsdatum der Person für immer.

## F) Wenn etwas nicht klappt

- **Chats laden nicht:** Hast du `033` ausgeführt? Dann lade die App neu.
- **Neue Version fehlt:** Warte 1–2 Minuten, lade die Seite neu und schließe die App ganz.
- **Alle sind ausgesperrt:** Als Owner kommst du immer rein. Markiere sie unter **Alterprüfung** als geprüft.
- **Fehlermeldung:** Schick sie mir, und ich schaue sie mir an.
