#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Ya Viene — demo-buses.sh
#  Lanza 2 buses simulados en la ruta R-106 para la demo:
#   B-042 → arranca al 80% del recorrido (YA PASÓ al pasajero del ~50%)
#   B-055 → arranca al 15% del recorrido (VIENE hacia el pasajero)
#
#  Y los mantiene vivos. Un simulador que se cae —se reinició el backend, se
#  cortó el MQTT, se cerró la terminal— no hace ruido: el bus se queda
#  quieto en el mapa y a los 5 min sale "sin señal" en las dos apps, que es
#  exactamente lo que no puede pasar en medio de una presentación. Aquí se
#  vigilan cada 5 s y se vuelven a levantar solos.
#
#  Uso:
#    bash scripts/demo-buses.sh             en primer plano (Ctrl+C para parar)
#    bash scripts/demo-buses.sh --fondo     sigue vivo al cerrar la terminal
#    bash scripts/demo-buses.sh --estado    ¿están corriendo?
#    bash scripts/demo-buses.sh --detener   para los que quedaron en fondo
# ═══════════════════════════════════════════════════════════════
set -uo pipefail

# La ruta absoluta se calcula ANTES del cd: `--fondo` se relanza a sí mismo
# y con la ruta relativa no se encontraría.
SCRIPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SCRIPT")/.."

LOG="${YA_VIENE_DEMO_LOG:-/tmp/yaviene-demo-buses.log}"
PIDFILE="${YA_VIENE_DEMO_PID:-/tmp/yaviene-demo-buses.pid}"

MODO=primerplano
for arg in "$@"; do
  case "$arg" in
    --fondo)   MODO=fondo ;;
    --estado)  MODO=estado ;;
    --detener) MODO=detener ;;
    -h|--help) sed -n '2,19p' "$SCRIPT" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Parámetro desconocido: $arg"; echo "Prueba: $0 --help"; exit 2 ;;
  esac
done

vive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

pid_guardado() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null)"
  vive "$pid" || return 1
  echo "$pid"
}

case "$MODO" in
  estado)
    if PID="$(pid_guardado)"; then
      echo "Buses en fondo, vigilados por el proceso $PID."
      echo "Registro: $LOG"
    else
      echo "No hay buses en fondo."
    fi
    exit 0
    ;;
  detener)
    if PID="$(pid_guardado)"; then
      # Al vigilante se le manda TERM; su trap se lleva a los dos
      # simuladores. Matar un simulador suelto no sirve: lo levanta otra vez.
      kill -TERM "$PID" 2>/dev/null
      # El vigilante duerme de 5 en 5 s y bash no atiende el trap hasta que
      # el sleep termina: hay que darle ese margen antes de rematarlo.
      for _ in $(seq 1 20); do vive "$PID" || break; sleep 0.5; done
      vive "$PID" && kill -KILL "$PID" 2>/dev/null
      echo "Buses detenidos."
    else
      echo "No había buses en fondo."
    fi
    # Red de seguridad: si al vigilante hubo que rematarlo con KILL, su trap
    # no corrió y los dos simuladores quedaron sueltos publicando.
    pkill -f 'scripts/simulate-bus.mjs' 2>/dev/null
    rm -f "$PIDFILE"
    exit 0
    ;;
  fondo)
    if PID="$(pid_guardado)"; then
      echo "Ya están corriendo (proceso $PID). Para reiniciarlos:"
      echo "  bash scripts/demo-buses.sh --detener && bash scripts/demo-buses.sh --fondo"
      exit 0
    fi
    nohup bash "$SCRIPT" > "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 3
    if vive "$(cat "$PIDFILE")"; then
      echo "Buses corriendo en fondo (proceso $(cat "$PIDFILE"))."
      echo "  Registro:  tail -f $LOG"
      echo "  Detener:   bash scripts/demo-buses.sh --detener"
    else
      echo "Arrancaron y se cayeron enseguida. Mira $LOG"
      rm -f "$PIDFILE"
      exit 1
    fi
    exit 0
    ;;
esac

# ── Vigilante en primer plano ─────────────────────────────────────
# En el portátil las variables salen de local.env. Dentro de la máquina de
# Fly ese archivo no existe —lo excluye .dockerignore porque lleva
# JWT_SECRET y ADMIN_API_KEY— y las variables ya vienen del entorno (fly
# secrets). Sin este `if`, `set -e` mataba el script en la línea del source.
if [ -f local.env ]; then
  set -a
  source local.env
  set +a
fi

CAPTURE_INTERVAL_MS="${CAPTURE_INTERVAL_MS:-400}"
ROUTE_ID="${ROUTE_ID:-R-106}"

PID_042=""
PID_055=""

# $1 = nombre de la variable donde guardar el PID, $2 = bus,
# $3 = fracción de arranque, $4 = teléfono del conductor simulado.
arrancar() {
  BUS_ID="$2" ROUTE_ID="$ROUTE_ID" PHONE="$4" START_FRACTION="$3" SENTIDO=ida \
    CAPTURE_INTERVAL_MS="$CAPTURE_INTERVAL_MS" node scripts/simulate-bus.mjs &
  printf -v "$1" '%s' "$!"
}

limpiar() {
  trap - EXIT INT TERM
  kill "$PID_042" "$PID_055" 2>/dev/null
  echo ""
  echo "Buses detenidos."
  exit 0
}
trap limpiar EXIT INT TERM

echo "▶ Bus YA PASÓ   B-042 · ${ROUTE_ID} · arranca en 80% del recorrido"
arrancar PID_042 B-042 0.80 3000000000
sleep 1
echo "▶ Bus QUE VIENE B-055 · ${ROUTE_ID} · arranca en 15% del recorrido"
arrancar PID_055 B-055 0.15 3000000001

echo "Ambos buses corriendo y vigilados (Ctrl+C para detenerlos a los dos)."
echo "Para ver el estado 'sin señal' a propósito: kill $PID_042 y espera 5 min;"
echo "  el vigilante lo levanta en 5 s, así que primero detén el vigilante."

while true; do
  sleep 5
  if ! vive "$PID_042"; then
    echo "[vigilante] B-042 se cayó — lo levanto otra vez"
    arrancar PID_042 B-042 0.80 3000000000
  fi
  if ! vive "$PID_055"; then
    echo "[vigilante] B-055 se cayó — lo levanto otra vez"
    arrancar PID_055 B-055 0.15 3000000001
  fi
done
