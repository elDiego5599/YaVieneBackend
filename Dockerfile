# Ya Viene — imagen de producción del backend.
#
# La imagen anterior arrancaba `npm run dev`, que es `tsx watch`: un modo de
# desarrollo que recompila en caliente y se queda con el árbol de fuentes
# encima. Aquí TypeScript se compila una vez, dentro de la imagen, y lo que
# corre es el JavaScript ya compilado.

# ── Etapa de compilación ─────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# better-sqlite3 es un módulo nativo y no publica binario precompilado para
# musl (que es la libc de Alpine): sin estas tres herramientas, `npm ci`
# falla al compilarlo.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Fuera las dependencias de desarrollo (tsx, typescript, fast-check…): a
# `node dist/index.js` no le hace falta ninguna. Se poda aquí, después de
# compilar, para que la etapa final copie el árbol ya limpio.
RUN npm prune --omit=dev

# ── Imagen final ─────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# NODE_ENV=production no es decorativo: hace obligatorios JWT_SECRET
# (index.ts) y ADMIN_API_KEY (auth/http.ts). Si falta alguno, el proceso
# revienta al arrancar en vez de quedarse corriendo con un secret por
# defecto y rotar todos los tokens en silencio.
ENV NODE_ENV=production

# libstdc++ es lo único que el binario nativo de better-sqlite3 necesita en
# tiempo de ejecución. bash es para scripts/demo-buses.sh, que es #!/bin/bash
# con `set -euo pipefail` y no corre sobre el sh de busybox.
RUN apk add --no-cache libstdc++ bash

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Los buses simulados se lanzan desde dentro de la máquina, porque el broker
# MQTT solo escucha en loopback a propósito (MQTT_HOST=127.0.0.1). Por eso
# scripts/ viaja en la imagen, con la geometría real de las rutas que hay en
# scripts/data. simulate-bus.mjs solo usa módulos nativos de Node, así que no
# arrastra dependencias.
COPY scripts ./scripts

# Un solo puerto: la API, el WebSocket de socket.io (/ws) y el MQTT sobre
# WebSocket (/mqtt) comparten este mismo servidor HTTP.
EXPOSE 3000

CMD ["node", "dist/index.js"]
