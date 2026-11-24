#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8742
URL="http://127.0.0.1:${PORT}"

# 1. Prüfen, ob HomeVault auf dem Standard-Port bereits läuft -> nur Browser öffnen
if curl -fsS --max-time 1 "${URL}/manifest.webmanifest" >/dev/null 2>&1; then
  open "${URL}"
  osascript -e 'tell application "Terminal" to if (count of windows) > 0 then close front window' >/dev/null 2>&1 &
  exit 0
fi

# 2. Python 3 prüfen
if ! command -v python3 >/dev/null 2>&1; then
  osascript -e 'display alert "Python 3 nicht gefunden" message "Bitte installiere Python 3 (python.org oder xcode-select --install), um den lokalen HomeVault-Server zu starten."' >/dev/null 2>&1
  exit 1
fi

# 3. Falls Port 8742 anderweitig belegt ist, nächsten freien Port suchen
PORT=$(python3 - <<'PY'
import socket
for p in range(8742, 8765):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", p))
            print(p)
            break
        except OSError:
            continue
PY
)
PORT="${PORT:-8742}"
URL="http://127.0.0.1:${PORT}"

# 4. Lokalen HTTP-Server entkoppelt im Hintergrund starten (kein offenes Terminal nötig)
nohup python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory "${SCRIPT_DIR}" >/dev/null 2>&1 </dev/null &
disown 2>/dev/null || true

# 5. Kurz warten bis Server erreichbar ist, dann Standardbrowser öffnen
for _ in 1 2 3 4 5 6 7 8; do
  if curl -fsS --max-time 1 "${URL}/manifest.webmanifest" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

open "${URL}"

# 6. Terminal-Fenster sauber schließen und Skript beenden
osascript -e 'tell application "Terminal" to if (count of windows) > 0 then close front window' >/dev/null 2>&1 &
exit 0
