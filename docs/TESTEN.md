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

## Admin-PIN und Sperre
- [ ] Ohne PIN zeigt der Admin-Bereich keine Chats.
- [ ] Richtige PIN entsperrt für 10 Minuten.
- [ ] 5 falsche Eingaben hintereinander: Sperre für 15 Minuten.
- [ ] Auch die richtige PIN wird während der Sperre abgelehnt.
- [ ] Nach Ablauf der 10 Minuten ist erneute Eingabe nötig.
- [ ] Jeder Zugriff erscheint im Audit-Log.
- [ ] Nur der Owner kann den Bereich öffnen (Admin und Moderator nicht).

## Passwort vergessen
- [ ] Zurücksetzen mit Recovery-Code klappt und liefert einen neuen Code.
- [ ] Der alte Recovery-Code gilt danach nicht mehr.
- [ ] Ticket senden klappt. Das vierte Ticket innerhalb einer Stunde wird abgelehnt.
- [ ] Admin erzeugt temporäres Passwort. Der Nutzer muss beim Login ein neues setzen.

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
