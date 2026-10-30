#!/bin/bash
# Startet den lokalen Server. Beim ersten Mal fragt er einmal nach dem Passwort und merkt es sich
# nur auf diesem Computer (Datei tools/.passwort, wird nie hochgeladen).
cd "$(dirname "$0")/.." || exit 1
PW_FILE="tools/.passwort"
if [ ! -s "$PW_FILE" ]; then
  read -r -s -p "Passwort von bela_owner (wird beim Tippen nicht angezeigt): " PW
  echo
  umask 077
  printf '%s' "$PW" > "$PW_FILE"
fi
FLARCHAT_PASSWORD="$(cat "$PW_FILE")" node tools/lokal-admin.mjs || {
  rm -f "$PW_FILE"
  echo "Das hat nicht geklappt. Das gemerkte Passwort wurde gelöscht. Starte noch einmal und tippe es neu ein."
}
