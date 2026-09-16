#!/bin/bash
# Levanta el túnel en primer plano para que launchd pueda reiniciarlo.
#
# `ngrok start yaviene` usa el túnel con nombre de la configuración de ngrok
# (~/Library/Application Support/ngrok/ngrok.yml), que es donde viven el
# dominio fijo y el authtoken. Aquí no se repiten ni uno ni otro: el día que
# cambien, se cambian en un solo sitio y este servicio no se entera.
#
# Nunca cloudflared: su URL cambia en cada arranque y obligaría a recompilar
# y repartir las apps otra vez.
set -u

TUNEL="${1:-yaviene}"

if ! command -v ngrok >/dev/null 2>&1; then
  printf 'ngrok no está en el PATH del servicio (%s).\n' "$PATH" >&2
  exit 78
fi

exec ngrok start "$TUNEL" --log=stdout --log-format=logfmt
