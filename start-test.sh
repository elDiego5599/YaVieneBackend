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
nohup node dist/index.js > /tmp/yaviene-backend.log 2>&1 &
nohup cloudflared tunnel --url http://localhost:3000 --no-autoupdate > /tmp/cloudflared.log 2>&1 &

# La Mac no debe dormirse mientras el teléfono haga pruebas.
caffeinate -d -i -s -w $! &

sleep 8
URL=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" /tmp/cloudflared.log | head -1)
echo "Backend OK. URL pública: $URL"
echo "Compilar las apps con: --dart-define=BACKEND_URL=$URL"
