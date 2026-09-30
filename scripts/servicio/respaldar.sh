#!/bin/bash
# Lo que corre launchd cada hora: una copia de la base y, detrás, la prueba
# de que esa copia sirve para volver.
#
# Son dos pasos y no uno porque un respaldo que nadie abre no es un respaldo:
# `respaldar.mjs` copia y poda, `probar-restauracion.mjs` abre la copia más
# nueva, le pasa `integrity_check` y compara las tablas con la base viva. Si
# el segundo falla, el servicio sale distinto de cero y el motivo queda en
# respaldo.log, que es donde hay que mirar antes de confiar en la carpeta.
#
# No toca la base viva: `.backup()` de SQLite copia en caliente, con el
# backend en pie y sin bloquearlo.
set -u
# Copias y log solo del dueño: la base trae teléfonos y hashes.
umask 077

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1

# El backend lee local.env al arrancar; aquí se lee por si algún día fija la
# ruta de la base. Si no existe, la ruta por defecto (data/yaviene.db) es la
# misma que usa el backend.
if [ -f local.env ]; then
  set -a
  # shellcheck disable=SC1091
  source local.env
  set +a
fi

printf '\n===== %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')"

if ! node scripts/respaldar.mjs; then
  printf 'La copia falló: no se probó la restauración.\n' >&2
  exit 1
fi

exec node scripts/probar-restauracion.mjs
