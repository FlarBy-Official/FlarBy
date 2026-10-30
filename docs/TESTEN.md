# FlarChat – manuelle Test-Checkliste

Hake jeden Punkt ab. Nutze mindestens zwei Browser oder Geräte (oder ein Privatfenster).

## Registrierung
- [ ] Erster Nutzer kann sich registrieren und wird **Owner**.
- [ ] Der Wiederherstellungscode (`XXXX-XXXX`) wird angezeigt.
- [ ] Das große Hinweis-Feld zum Mitlesen ist sichtbar.
- [ ] Registrierung ohne Code ist nicht möglich.
- [ ] Ungültiger Benutzername (Großbuchstaben, Leerzeichen, zu kurz) wird abgelehnt oder in Kleinbuchstaben umgewandelt.
- [ ] Passwort unter 8 Zeichen wird abgelehnt.
- [ ] Anmeldung direkt über die Supabase-Signup-Schnittstelle ist nicht möglich (Signups aus).

## Codes sind einmalig
- [ ] Registrierungscode funktioniert genau einmal.
- [ ] Derselbe Code beim zweiten Versuch: Fehlermeldung.
- [ ] Abgelaufener oder widerrufener Code funktioniert nicht.
- [ ] „Reaktivieren“ erzeugt einen **neuen** Code. Der alte bleibt ungültig.
- [ ] Chat-Code tritt einer Gruppe als Member bei, nur einmal.

## Rollen und Rechte
- [ ] Member kann schreiben und Bilder senden, aber keine Mitglieder entfernen.
- [ ] Ohne Recht `send_messages` kann niemand schreiben.
- [ ] Gruppen-Admin kann Mitglieder entfernen, aber die Gruppe nicht löschen und nicht übergeben.
- [ ] Gruppen-Owner kann löschen und Eigentum übergeben.
- [ ] Eigene Rolle mit Farbe und Rechten anlegen, zuweisen, löschen (Mitglieder werden Member).
- [ ] Moderator sieht Meldungen, aber keine Sperr-Funktion.
- [ ] Admin kann sperren und Codes erzeugen.
- [ ] Globaler Admin liest fremde Gruppen **nicht** mit.
- [ ] Nur Owner kann globale Rollen und Verifiziert-Haken vergeben.
- [ ] Stummgeschalteter und gesperrter Nutzer kann nicht schreiben.

## Bearbeiten (3 Tage)
- [ ] Eigene Nachricht lässt sich bearbeiten, „bearbeitet“ wird angezeigt.
- [ ] Fremde Nachricht lässt sich nicht bearbeiten.
- [ ] Nachricht älter als 3 Tage lässt sich nicht bearbeiten (Test: im SQL Editor `created_at` einer Testnachricht zurücksetzen).
- [ ] Alte Fassung ist im Admin-Bereich sichtbar.

## Löschen
- [ ] Eigene Nachricht jederzeit löschbar („Nachricht gelöscht“).
- [ ] Fremde Nachricht nur mit Recht `delete_others_messages`.
- [ ] Gelöschte Nachricht ist im Admin-Bereich weiterhin lesbar.
- [ ] Moderator kann nur gemeldete Nachrichten löschen.

## Melden
- [ ] Nachricht melden mit Grund funktioniert.
- [ ] Meldung erscheint im Team-Bereich mit Kontext (5 davor, 5 danach).
- [ ] Meldung lässt sich erledigen. Verwarnen und Stummschalten funktionieren.
- [ ] Normale Nutzer sehen keine Meldungen.

## Admin-Bereich
- [ ] Nur der Owner sieht den Knopf und kann Chats lesen.
- [ ] Normale Nutzer bekommen beim Aufruf der Funktionen einen Fehler.
- [ ] Jeder Zugriff steht im Audit-Log.

## Passwort vergessen
- [ ] Zurücksetzen mit Recovery-Code klappt und liefert einen neuen Code.
- [ ] Der alte Recovery-Code gilt danach nicht mehr.
- [ ] Ticket senden klappt. Das vierte Ticket innerhalb einer Stunde wird abgelehnt.
- [ ] Admin erzeugt temporäres Passwort. Der Nutzer muss beim Login ein neues setzen.

## Support-Tickets (/ticket)

## Ansage-Kanal
- [ ] „FlarChat Updates“ steht ganz oben, mit ✔. Kein Verlassen, kein Stummschalten.
- [ ] Normale Nutzer sehen nur den Hinweis „Nur Admins und der Owner können hier schreiben.“
- [ ] Admin schreibt: Nachricht erscheint rot mit Anzeigename. Push kommt bei allen.
- [ ] Nachricht mit `/React` am Ende: alle können reagieren, `/React` ist unsichtbar. Sonst nur Admins.
- [ ] Neuer Nutzer ist automatisch im Kanal.
- [ ] `/ticket` tippen und senden: Es wird nichts gesendet, es öffnet sich ein Fenster (Grund + Text, 10–500 Zeichen).
- [ ] Beim Tippen von `/` erscheint der Vorschlag „/ticket“.
- [ ] Ticket öffnen: Chat „Ticket [Name] #0001“ erscheint beim Nutzer und bei allen Teamlern, erste Nachricht = Grund.
- [ ] Zweites `/ticket` bei offenem Ticket: Hinweis mit Knopf „Zu meinem Ticket“, kein neues Ticket.
- [ ] Im Ticket gibt es keine Reaktionen, Umfragen, Sprachnachrichten, Weiterleiten, Melden.
- [ ] Stummgeschalteter Nutzer kann kein Ticket öffnen und nicht darin schreiben.
- [ ] Teamler schließt das Ticket: Systemzeile „Ticket geschlossen von …“, Nutzer kann nur lesen, Ticket verschwindet bei allen Teamlern.
- [ ] `/ticket` bei geschlossenem, nicht gelöschtem Ticket: Hinweis, erst löschen. Nach „Ticket löschen“ geht ein neues.
- [ ] Neuer Teamler (Rolle vergeben) ist sofort in offenen Tickets; entzogene Rolle: raus aus offenen Tickets.
- [ ] Owner sieht alle Tickets (auch geschlossene und gelöschte) im Admin-Panel unter „Support“.

## RLS-Schutz (Datenschutz in der Datenbank)
Prüfe mit einem zweiten, eingeloggten Nutzer. Beispiel in der Browser-Konsole mit dem Supabase-Client.
- [ ] Fremde Chats: `select` auf `messages` eines Chats, in dem man nicht Mitglied ist, liefert keine Zeilen.
- [ ] `profile_secrets` und `admin_pins` sind nicht lesbar.
- [ ] Direktes `update` der eigenen `global_role` auf `owner` schlägt fehl.
- [ ] Senden in einen fremden Chat (`insert` in `messages`) schlägt fehl.
- [ ] Bilder aus fremden Chats sind nicht abrufbar (Bucket `media` ist privat).
- [ ] Ohne Login (anon) sind keine Nachrichten und Profile lesbar.
- [ ] `service_role`-Key steht nirgends im Repo (Suche nach `service_role` und `eyJ`).

## App und Handy
- [ ] Installation als App funktioniert (iPhone und Android).
- [ ] Dunkelmodus funktioniert.
- [ ] Neue Nachrichten erscheinen sofort beim anderen Nutzer (Echtzeit).
- [ ] App-PIN sperrt die App nach dem Neustart.
- [ ] `/clear` fragt nach und löscht dann alle Nachrichten für alle. Normale Mitglieder bekommen eine Fehlermeldung.

## Altersverifizierung
- [ ] Nach Migration 032 sind alle außer Owner gesperrt: Beim Login erscheint nur das Formular „Alter bestätigen“.
- [ ] Owner kommt direkt in die App und sieht „🎂 Alterprüfung“.
- [ ] Geburtsdatum unter 14: Meldung „zu jung“, keine Anfrage in der Warteschlange.
- [ ] Mit Ausweis-Foto: Anfrage erscheint beim Team, „Foto ansehen“ zeigt das Bild, der Blick steht im Protokoll.
- [ ] Mod: „Vorprüfung OK“, Admin/Owner: „Annehmen“. Danach kommt die Person automatisch in die App.
- [ ] „Ablehnen“ braucht einen Grund, die Person sieht ihn und kann neu einreichen. Das Geburtsdatum ist dann nicht mehr änderbar.
- [ ] Niemand kann sich selbst prüfen (eigene Anfrage fehlt in der Liste).
- [ ] Owner setzt bei einer Person „Elternteil“. Ein Kind wählt „Ein Elternteil bürgt“, das Elternteil bestätigt im Menü „Bürgen-Anfragen“ (max. 3 Kinder), danach prüft das Team.
- [ ] Admin: „Als geprüft markieren“ und „Wieder sperren“ funktionieren. Owner: „Fotos & Datum löschen“.
- [ ] Ungeprüfter Nutzer: `select` auf `messages` und `chat_overview` liefert nichts, `insert` in `messages` schlägt fehl.
