#!/bin/bash
# Arranca el backend de pruebas + túnel cloudflared (gratis).
# Uso: ./start-test.sh
set -e
cd "$(dirname "$0")"

pkill -f "node dist/index.js" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1

set -a
source local.env
set +a
# Todo con </dev/null y fds redirigidos + disown para que el script
# devuelva el control al terminal y los procesos queden desacoplados.
nohup node dist/index.js </dev/null > /tmp/yaviene-backend.log 2>&1 &
disown
nohup cloudflared tunnel --url http://localhost:3000 --no-autoupdate </dev/null > /tmp/cloudflared.log 2>&1 &
disown

# La Mac no debe dormirse mientras el teléfono haga pruebas.
nohup caffeinate -d -i -s </dev/null > /dev/null 2>&1 &
disown

sleep 8
URL=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" /tmp/cloudflared.log | head -1)
echo "Backend OK. URL pública: $URL"
echo "Compilar las apps con: --dart-define=BACKEND_URL=$URL"
