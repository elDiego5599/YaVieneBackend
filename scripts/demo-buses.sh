#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Ya Viene — demo-buses.sh
#
#  YA NO HACE FALTA PARA LA DEMO: el backend levanta y vigila esta misma
#  flota él solo (src/demo/flota_demo.ts). Este script es un supervisor
#  opcional para usar el coordinador si se apagó el del backend. Corriendo
#  backend y script a la vez la flota se registra dos veces y
#  las sesiones se echan la una a la otra: apaga primero la del backend con
#  YA_VIENE_FLOTA_DEMO=0.
#
#  Pone buses simulados a rodar en TODAS las rutas del catálogo, para que
#  cualquier ruta que se abra —en el panel o en la app del pasajero— tenga
#  buses moviéndose sin ir a arrancar nada. Doce por ruta, en puntos equidistantes
#  y alternando sentidos. En R-106, la de la demo, van más rápido:
#   ABC123 → arranca cerca de la mitad y en sentido venida
#   seis buses circulan en cada sentido
#
#  Y los mantiene vivos. Si el coordinador cae —se reinició el backend, se
#  cortó el MQTT, se cerró la terminal— los buses se quedan quietos en el mapa y a los 5 min sale "sin señal" en las dos apps, que es
#  exactamente lo que no puede pasar en medio de una presentación. Aquí se
#  vigilan cada 5 s y se vuelven a levantar solos.
#
#  Uso:
#    bash scripts/demo-buses.sh             en primer plano (Ctrl+C para parar)
#    bash scripts/demo-buses.sh --fondo     sigue vivo al cerrar la terminal
#    bash scripts/demo-buses.sh --estado    ¿están corriendo?
#    bash scripts/demo-buses.sh --detener   para los que quedaron en fondo
#
#  RUTAS_DEMO="R-106 R-101" limita a esas rutas, por si la máquina se ahoga
#  con la flota completa.
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
    -h|--help) sed -n '2,33p' "$SCRIPT" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
      echo "Proceso simulador activo: $(pgrep -f 'scripts/simulate-demo-flota.ts' | wc -l | tr -d ' ')."
      echo "Registro: $LOG"
    else
      echo "No hay buses en fondo."
    fi
    exit 0
    ;;
  detener)
    if PID="$(pid_guardado)"; then
      # Al vigilante se le manda TERM; su trap se lleva a los simuladores.
      # El supervisor termina también el único proceso simulador.
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
    # no corrió y los simuladores quedaron sueltos publicando.
    pkill -f 'scripts/simulate-demo-flota.ts' 2>/dev/null
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
    sleep 8
    if vive "$(cat "$PIDFILE")"; then
      echo "Buses corriendo en fondo (proceso $(cat "$PIDFILE"))."
      echo "  Proceso de flota vivo: $(pgrep -f 'scripts/simulate-demo-flota.ts' | wc -l | tr -d ' ')"
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

# La flota auxiliar usa el mismo coordinador de un solo proceso que arranca
# el backend. Puede limitar rutas con RUTAS_DEMO="R-106 R-101".
if [ -n "${RUTAS_DEMO:-}" ]; then
  YA_VIENE_FLOTA_RUTAS="$(printf '%s' "$RUTAS_DEMO" | tr ' ' ',')"
  export YA_VIENE_FLOTA_RUTAS
fi

PIDS=()

arrancar() {
  YA_VIENE_FLOTA_DEMO=1 node --import tsx scripts/simulate-demo-flota.ts &
  PIDS=("$!")
}

limpiar() {
  trap - EXIT INT TERM
  kill "${PIDS[@]}" 2>/dev/null
  echo ""
  echo "Buses detenidos."
  exit 0
}
trap limpiar EXIT INT TERM

while true; do
  arrancar
  echo "▶ Flota demo en un proceso Node; rutas: ${RUTAS_DEMO:-todas las del catálogo}."
  if wait "${PIDS[0]}"; then
    echo "El proceso de flota terminó sin error."
    break
  fi
  echo "[vigilante] El proceso de flota falló; reintento en 5 s."
  sleep 5
done
