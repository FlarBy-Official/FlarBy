#!/bin/bash
# Startet den lokalen Server auf http://localhost:8787 (nichts einzugeben).
# Optional: Liegt eine Datei tools/.passwort vor (nur auf diesem Computer, nie hochgeladen), loggt er automatisch ein.
cd "$(dirname "$0")/.." || exit 1
if [ -s tools/.passwort ]; then export FLARCHAT_PASSWORD="$(cat tools/.passwort)"; fi
exec node tools/lokal-admin.mjs
