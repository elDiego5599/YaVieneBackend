#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Ya Viene — demo-buses.sh
#  Lanza 2 buses simulados en la ruta R-106 para la demo:
#   B-042 → arranca al 80% del recorrido (YA PASÓ al pasajero del ~50%)
#   B-055 → arranca al 15% del recorrido (VIENE hacia el pasajero)
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source local.env
set +a

CAPTURE_INTERVAL_MS="${CAPTURE_INTERVAL_MS:-400}"
ROUTE_ID="${ROUTE_ID:-R-106}"

echo "▶ Bus YA PASÓ   B-042 · ${ROUTE_ID} · arranca en 80% del recorrido"
BUS_ID=B-042 ROUTE_ID="$ROUTE_ID" PHONE=3000000000 START_FRACTION=0.80 SENTIDO=ida \
  CAPTURE_INTERVAL_MS="$CAPTURE_INTERVAL_MS" node scripts/simulate-bus.mjs &
P1=$!

sleep 1

echo "▶ Bus QUE VIENE B-055 · ${ROUTE_ID} · arranca en 15% del recorrido"
BUS_ID=B-055 ROUTE_ID="$ROUTE_ID" PHONE=3000000001 START_FRACTION=0.15 SENTIDO=ida \
  CAPTURE_INTERVAL_MS="$CAPTURE_INTERVAL_MS" node scripts/simulate-bus.mjs &
P2=$!

trap 'kill $P1 $P2 2>/dev/null' EXIT

echo "Ambos buses corriendo (Ctrl+C para detenerlos a los dos)."
echo "Mata solo un proceso para ver el ghost: kill $P1 (o $P2)"
wait
