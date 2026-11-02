# Admin-Panel: Redesign-Konzept

Den Entwurf zum Anschauen gibt es in `docs/admin-redesign.html`. Einfach im Browser öffnen. Er nutzt Tailwind nur über das CDN. Die echte App bleibt bei reinem HTML, CSS und JS.

## 1. Navigation
- **Eine Sidebar statt zwei Tab-Zeilen.** Kein „Mehr ▾“ mehr. Alles ist mit einem Klick erreichbar.
- Drei Gruppen mit kleinen Überschriften:
  - **Verwalten:** Nutzer, Chats, Ansage, Alter, Codes, Wörter
  - **Hilfe:** Meldungen, Tickets, Support
  - **Überblick:** Statistik, Aktivität, Fehler, Audit-Log
- „⚡ Schnell“ steht ganz oben.
- Der aktive Punkt ist dunkel gefüllt. Offene Aufgaben (z. B. Warteschlange) zeigen eine Zahl.
- Auf dem Handy: Die Sidebar wird zu einem Menü-Knopf oder einer unteren Leiste.
- Die rote Vollbreit-Leiste wird zu einem kleinen gelben Hinweis.

## 2. Nutzerliste
- Eine echte **Tabelle** mit den Spalten Nutzer, Status, Geburtsdatum, Aktionen.
- **Ein Drei-Punkte-Menü (⋮)** pro Zeile statt 5 Knöpfen. Wichtige Aktionen stehen oben im Menü.
- Gefährliche Aktionen (Sperren, Löschen) stehen unten und sind rot.
- Nur diese Zeilen-Aktionen sind sichtbar, wenn man sie braucht. Das macht die Liste ruhig.

## 3. Status-Badges
- Kleine runde Pillen mit Punkt und dezenter Farbe:
  - Geprüft = grün
  - Gesperrt = rot
  - Elternteil = grau
- Immer gleiche Größe und gleiche Form.
- Das Datum bekommt eine eigene Spalte und ist kein Badge mehr.

## 4. Look
- Helles Theme, Grautöne (zinc), dünne Rahmen, `rounded-lg`.
- Rot nur noch für Warnungen und gefährliche Aktionen.
- Icons im Lucide-Stil (Auge, Haken, Kalender, Sperren, Papierkorb).

## Nächster Schritt
Wenn dir der Entwurf gefällt, baue ich ihn in das echte Admin-Panel ein (reines CSS und JS).
