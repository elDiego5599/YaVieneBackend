#!/bin/bash
# Arranca el backend en primer plano, que es lo que launchd necesita para
# vigilarlo: si esto usara `nohup ... &`, launchd vería terminar el script al
# instante y lo reiniciaría en bucle.
#
# No compila. `npm run build` es una decisión de quien cambia el código, no
# algo que deba pasar sola en cada arranque: una compilación a medias dejaría
# el servicio dando vueltas sin que nadie mire el log.
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1

if [ ! -f dist/index.js ]; then
  printf 'No existe dist/index.js en %s. Corre `npm run build` y vuelve a cargar el servicio.\n' "$REPO" >&2
  # 78 es EX_CONFIG: el problema es el montaje, no el programa.
  exit 78
fi

if [ ! -f local.env ]; then
  printf 'Falta local.env en %s: sin JWT_SECRET el backend no arranca.\n' "$REPO" >&2
  exit 78
fi

# `set -a` exporta lo que traiga el archivo; el backend valida su contenido al
# arrancar y se detiene con un mensaje [Config] si algo falta.
set -a
# shellcheck disable=SC1091
source local.env
set +a

exec node dist/index.js
