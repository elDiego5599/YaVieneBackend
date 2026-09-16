#!/bin/bash
# Rota los logs de los servicios. launchd escribe siempre al mismo archivo y
# no rota nada: un backend que lleva semanas en pie llena el disco despacio y
# en silencio, y el día que hay que mirar por qué se cayó, `tail` abre un
# archivo de cientos de megas.
#
# Uso: rotar-logs.sh [carpeta] [tamaño máximo en bytes]
#   Por defecto: ~/Library/Logs/YaViene y 10 MB.
#
# Rota por tamaño, no por fecha: un servicio tranquilo no tiene por qué
# estrenar archivo cada día. Guarda cinco generaciones (.1 a .5) y borra la
# sexta. No usa `mv` sobre el archivo vivo sin más: el proceso escribe por un
# descriptor ya abierto y seguiría escribiendo en el archivo renombrado, así
# que copia y trunca (copytruncate), que mantiene el descriptor válido.
set -u

CARPETA="${1:-$HOME/Library/Logs/YaViene}"
MAXIMO="${2:-10485760}"
GENERACIONES=5

if [ ! -d "$CARPETA" ]; then
  printf 'No existe la carpeta de logs %s; nada que rotar.\n' "$CARPETA"
  exit 0
fi

rotados=0
for log in "$CARPETA"/*.log; do
  [ -f "$log" ] || continue
  tamano=$(/usr/bin/stat -f%z "$log")
  [ "$tamano" -le "$MAXIMO" ] && continue

  # De la más vieja a la más nueva, para no pisar generaciones.
  n=$GENERACIONES
  rm -f "$log.$n"
  while [ "$n" -gt 1 ]; do
    anterior=$((n - 1))
    [ -f "$log.$anterior" ] && mv "$log.$anterior" "$log.$n"
    n=$anterior
  done

  cp "$log" "$log.1"
  : > "$log"
  rotados=$((rotados + 1))
  printf 'Rotado %s (%s bytes).\n' "$log" "$tamano"
done

printf 'Logs rotados: %s\n' "$rotados"
