#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Ya Viene — demo-buses.sh
#
#  YA NO HACE FALTA PARA LA DEMO: el backend levanta y vigila esta misma
#  flota él solo (src/demo/flota_demo.ts). Este script se queda para
#  arrancar buses contra un backend ajeno, o para probar la flota sin
#  reiniciarlo. Corriendo los dos a la vez cada bus se registra dos veces y
#  las sesiones se echan la una a la otra: apaga primero la del backend con
#  YA_VIENE_FLOTA_DEMO=0.
#
#  Pone buses simulados a rodar en TODAS las rutas del catálogo, para que
#  cualquier ruta que se abra —en el panel o en la app del pasajero— tenga
#  buses moviéndose sin ir a arrancar nada. Dos por ruta, en puntos
#  distintos del recorrido. En R-106, la de la demo, van más rápido:
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
#
#  RUTAS_DEMO="R-106 R-101" limita a esas rutas, por si la máquina se ahoga
#  con doce simuladores.
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
      echo "Corriendo ahora: $(pgrep -f 'scripts/simulate-bus.mjs' | wc -l | tr -d ' ') simuladores."
      echo "Registro: $LOG"
    else
      echo "No hay buses en fondo."
    fi
    exit 0
    ;;
  detener)
    if PID="$(pid_guardado)"; then
      # Al vigilante se le manda TERM; su trap se lleva a los simuladores.
      # Matar un simulador suelto no sirve: lo levanta otra vez.
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
    sleep 8
    if vive "$(cat "$PIDFILE")"; then
      echo "Buses corriendo en fondo (proceso $(cat "$PIDFILE"))."
      echo "  Simuladores vivos: $(pgrep -f 'scripts/simulate-bus.mjs' | wc -l | tr -d ' ')"
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

# La ruta de la demo va a 400 ms: es la que se mira de cerca y donde el
# movimiento tiene que verse fluido. Las demás a 1,5 s, que en pantalla se
# ve igual de continuo y deja doce simuladores cabiendo en un portátil.
RAPIDO="${CAPTURE_INTERVAL_MS:-400}"
LENTO="${CAPTURE_INTERVAL_MS_RESTO:-1500}"

# bus · ruta · fracción del recorrido donde arranca · teléfono · intervalo.
# Dos por ruta y en extremos opuestos, para que en cualquier ruta que se abra
# haya uno acercándose y otro alejándose. B-901 ya existía en R-101 de una
# demo vieja: se reusa a propósito, así deja de ser el fantasma "sin señal"
# que ensuciaba esa ruta y pasa a ser uno de los buses vivos.
FLOTA=(
  "B-042 R-106 0.80 3000000000 $RAPIDO"
  "B-055 R-106 0.15 3000000001 $RAPIDO"
  "B-901 R-101 0.35 3000000999 $LENTO"
  "B-201 R-101 0.70 3000000201 $LENTO"
  "B-202 R-102 0.20 3000000202 $LENTO"
  "B-203 R-102 0.65 3000000203 $LENTO"
  "B-204 R-103 0.25 3000000204 $LENTO"
  "B-205 R-103 0.75 3000000205 $LENTO"
  "B-206 R-104 0.30 3000000206 $LENTO"
  "B-207 R-104 0.60 3000000207 $LENTO"
  "B-208 R-105 0.10 3000000208 $LENTO"
  "B-209 R-105 0.55 3000000209 $LENTO"
)

# RUTAS_DEMO recorta la lista sin tocar el archivo, por si la máquina no da.
if [ -n "${RUTAS_DEMO:-}" ]; then
  FILTRADA=()
  for fila in "${FLOTA[@]}"; do
    set -- $fila
    case " $RUTAS_DEMO " in *" $2 "*) FILTRADA+=("$fila") ;; esac
  done
  FLOTA=("${FILTRADA[@]}")
  [ "${#FLOTA[@]}" -gt 0 ] || { echo "RUTAS_DEMO='$RUTAS_DEMO' no coincide con ninguna ruta."; exit 2; }
fi

PIDS=()

# $1 = índice dentro de FLOTA. Guarda el PID él mismo en vez de imprimirlo:
# capturarlo con $(...) colgaba el script para siempre, porque el simulador
# hereda la tubería de la sustitución y nunca la cierra.
arrancar() {
  local i="$1"
  set -- ${FLOTA[$i]}
  BUS_ID="$1" ROUTE_ID="$2" START_FRACTION="$3" PHONE="$4" SENTIDO=ida \
    CAPTURE_INTERVAL_MS="$5" node scripts/simulate-bus.mjs &
  PIDS[$i]=$!
}

limpiar() {
  trap - EXIT INT TERM
  kill "${PIDS[@]}" 2>/dev/null
  echo ""
  echo "Buses detenidos."
  exit 0
}
trap limpiar EXIT INT TERM

for i in "${!FLOTA[@]}"; do
  set -- ${FLOTA[$i]}
  echo "▶ $1 · $2 · arranca en $(awk -v f="$3" 'BEGIN{printf "%d", f*100}')% del recorrido"
  arrancar "$i"
  # Escalonados: doce simuladores registrando conductor a la vez son doce
  # peticiones simultáneas al backend en el primer segundo.
  sleep 0.4
done

echo ""
echo "${#FLOTA[@]} buses corriendo y vigilados (Ctrl+C para detenerlos todos)."

while true; do
  sleep 5
  for i in "${!FLOTA[@]}"; do
    if ! vive "${PIDS[$i]}"; then
      set -- ${FLOTA[$i]}
      echo "[vigilante] $1 ($2) se cayó — lo levanto otra vez"
      arrancar "$i"
    fi
  done
done
