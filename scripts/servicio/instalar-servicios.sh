#!/bin/bash
# Genera los cuatro servicios de launchd de este Mac a partir de las
# plantillas de al lado, con las rutas reales resueltas aquí (repo, node,
# ngrok).
#
# Instala, pero NO carga: cargar ahora mataría o duplicaría el backend y el
# túnel que estén corriendo a mano. Al final imprime los dos comandos que
# hacen falta, para correrlos cuando convenga —nunca en mitad de una demo—.
#
# Uso: bash scripts/servicio/instalar-servicios.sh
#   DESTINO=/otra/carpeta  para probarlo sin tocar ~/Library/LaunchAgents.
set -u

AQUI="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
DESTINO="${DESTINO:-$HOME/Library/LaunchAgents}"
LOGS="${LOGS_YAVIENE:-$HOME/Library/Logs/YaViene}"

NODE="$(command -v node || true)"
NGROK="$(command -v ngrok || true)"
if [ -z "$NODE" ] || [ -z "$NGROK" ]; then
  printf 'Faltan node (%s) o ngrok (%s) en el PATH.\n' "${NODE:-no}" "${NGROK:-no}" >&2
  exit 1
fi

# El PATH del servicio se arma con las carpetas de node y ngrok, no con el
# PATH de este terminal: lo que funcione aquí tiene que funcionar bajo
# launchd, que arranca sin perfil de shell.
RUTA="$(dirname "$NODE"):$(dirname "$NGROK"):/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$DESTINO" "$LOGS"

instalados=0
for plantilla in "$AQUI"/com.yaviene.*.plist.plantilla; do
  nombre="$(basename "$plantilla" .plantilla)"
  salida="$DESTINO/$nombre"
  sed -e "s#@@SCRIPTS@@#$AQUI#g" \
      -e "s#@@REPO@@#$REPO#g" \
      -e "s#@@LOGS@@#$LOGS#g" \
      -e "s#@@PATH@@#$RUTA#g" \
      "$plantilla" > "$salida"
  if ! /usr/bin/plutil -lint "$salida" >/dev/null; then
    printf 'El plist generado no es válido: %s\n' "$salida" >&2
    exit 1
  fi
  printf 'Instalado %s\n' "$salida"
  instalados=$((instalados + 1))
done

printf '\n%s servicios escritos en %s (logs en %s).\n' "$instalados" "$DESTINO" "$LOGS"
cat <<'AYUDA'

Para activarlos (cada uno, cuando no haya demo en curso):
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yaviene.backend.plist
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yaviene.ngrok.plist
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yaviene.rotar-logs.plist
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yaviene.respaldo.plist

Antes de cargarlos, apaga el backend y el túnel que estén a mano, o habrá dos
procesos peleando por el puerto 3000 y por el mismo dominio de ngrok.

Para ver cómo van, y para pararlos:
  launchctl print gui/$UID/com.yaviene.backend
  launchctl bootout gui/$UID/com.yaviene.backend
AYUDA
