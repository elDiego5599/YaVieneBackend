# Ya Viene Backend

Backend en tiempo real para Ya Viene. Recibe las posiciones que mandan los
equipos GPS instalados en los buses por **MQTT** y las retransmite por
**WebSocket** (Socket.IO) a la app del pasajero y al panel de cada empresa.

## Arquitectura

GPS del bus (MQTT) → Broker Aedes → validación y SQLite → Socket.IO → app del pasajero / panel de empresa

## Inicio rápido

```bash
npm install
npm run build
npm start
```

Para desarrollo con hot-reload:
```bash
npm run dev
# o con el atajo:
make dev
```

Con Docker (hot-reload dentro del contenedor):
```bash
docker compose up --build   # o: make docker-dev
```

Servidor corre en `http://localhost:3000`.

El backend arranca con la flota simulada rodando, para que la app y el panel
tengan buses que enseñar. Para levantarlo sin ella —por ejemplo con tráfico
real, donde esas posiciones falsas viajan por el mismo canal que las buenas:

```bash
YA_VIENE_FLOTA_DEMO=0 npm start
```

## Configuración

| Variable | Uso |
|----------|-----|
| `JWT_SECRET` | Obligatoria. Firma los tokens de conductor y de administrador |
| `ADMIN_API_KEY` | Clave de superadministración (`x-admin-key`). Obligatoria en producción |
| `HTTP_PORT` / `MQTT_PORT` | Por defecto 3000 y 8883 |
| `HTTP_HOST` | Dónde escucha el HTTP. Por defecto `::` (IPv4 e IPv6 a la vez), y así se queda en el Mac y en Fly. Solo para máquinas sin IPv6, donde `::` falla con `EAFNOSUPPORT`: ahí `127.0.0.1` o `0.0.0.0`. Las pruebas la fijan en `127.0.0.1` (`tests/entorno.ts`) |
| `MQTT_HOST` | Dónde escucha el MQTT por TCP. Por defecto `127.0.0.1` |
| `HTTP_TLS_CERT_PATH` + `HTTP_TLS_KEY_PATH` | TLS del HTTP. Van juntas |
| `HTTP_TLS_EXTERNO` | `1` declara que el TLS lo termina un proxy delante (Fly, ngrok). En producción hace falta esto o el par TLS |
| `HTTP_ALLOW_REMOTE` | `1` deja que el API atienda a la red local fuera de producción. Sin ella, y sin `NODE_ENV=production`, solo atiende a esta máquina (loopback): ngrok, la flota demo y el panel local entran por ahí |
| `MQTT_TLS_CERT_PATH` + `MQTT_TLS_KEY_PATH` | TLS del MQTT por TCP. Van juntas |
| `CORS_ORIGINS` | Orígenes web autorizados, separados por coma. Sin ella no se emite CORS |
| `YA_VIENE_DB_PATH` | Ruta del archivo SQLite |
| `YA_VIENE_FLOTA_DEMO` | `0` apaga la flota simulada, `1` la enciende. Sin la variable: encendida en desarrollo, apagada con `NODE_ENV=production` |
| `YA_VIENE_MAX_MQTT_ANONIMAS_IP` | Conexiones de `/mqtt` que una misma dirección puede tener abiertas sin autenticar. Por defecto 20; la siguiente recibe `429` (`src/mqtt/guardia.ts`) |
| `YA_VIENE_SEED_DEMO` | `1` hace que una base **nueva** nazca con Sobusa (`EMP-01`) y su catálogo de rutas; `0` la deja vacía. Sin la variable: sembrada en desarrollo, vacía con `NODE_ENV=production`. Una base ya sembrada no cambia |

Producción es `NODE_ENV=production` (lo pone el Dockerfile). El arranque
**se detiene** con un mensaje `[Config]` si:

- `JWT_SECRET` falta o solo tiene espacios, o `ADMIN_API_KEY` solo tiene espacios;
- en producción falta `ADMIN_API_KEY`;
- un puerto no es un número entre 1 y 65535;
- `HTTP_HOST` no es una IP (`localhost` no vale), o en producción es de loopback
  (el proxy de Fly no llegaría);
- hay una sola de las dos rutas TLS (HTTP o MQTT);
- en producción, el HTTP no tiene TLS propio ni `HTTP_TLS_EXTERNO=1`
  (`fly.toml` lo declara, porque el TLS lo termina el proxy de Fly);
- un origen de `CORS_ORIGINS` no es exacto (`https://sitio.co`, sin barra final
  ni `*`), o en producción no es `https`;
- en producción, `MQTT_HOST` sale de loopback sin TLS de MQTT.

Fuera de producción, el MQTT expuesto sin TLS, `HTTP_ALLOW_REMOTE=1` y los
secretos cortos en producción solo avisan.

Al recibir `SIGINT`/`SIGTERM` el servidor detiene la flota simulada, cierra
Socket.IO, el broker y el HTTP, guarda las métricas y cierra SQLite. Si algo
se cuelga más de 10 s, guarda lo que puede y sale con código 1.

## Endpoints REST

Errores con la forma `{ "error": { "code", "message" } }`. Cuerpos JSON de
hasta 32 KB.

### Públicos

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | Proceso vivo |
| GET | `/api/ready` | Base y broker listos (503 si no) |
| GET | `/api/companies` | Empresas |
| GET | `/api/companies/:id/routes` | Rutas de una empresa |
| GET | `/api/companies/:id/buses` | Buses visibles de una empresa |
| GET | `/api/routes/:routeId/positions` | `{ routeId, buses }` con las posiciones actuales |
| GET | `/api/buses/:busId` | Posición de un bus (un bus oculto da el mismo `404` que uno inexistente) |
| POST | `/api/gps` | **Retirado.** 410: las posiciones entran solo por MQTT autenticado |

Las lecturas públicas admiten 120 por minuto e IP (`429 TOO_MANY_REQUESTS`).

### Equipo del bus (credencial de conductor)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/login` | `{ phoneNumber, pin, busId?, routeId? }` → `{ driver, token }` |
| GET | `/api/drivers/:phone` | Ficha propia con token de conductor. Sin permiso: siempre 403, exista o no |
| POST | `/api/buses/:busId/offline` | Fin de turno: quita el bus del mapa y revoca la sesión |

### Superadministración (`x-admin-key`)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/admin/drivers` | Provisiona una credencial `{ phoneNumber, name, pin, companyId, busId, routeId }`. `/api/drivers/register` es el mismo endpoint |
| POST | `/api/admin/empresas/:companyId/admin` | Crea o actualiza la cuenta de panel `{ username, password }` (12+ caracteres) |
| GET | `/api/metrics` | Contadores operativos |

Cada uno admite 20 intentos por minuto e IP, **incluidos los que traen la
clave mal** (`429 RATE_LIMITED`).

### Panel de empresa (`Authorization: Bearer <token>` de `/api/admin/login`)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/admin/login` | `{ username, password }` → `{ token, company }` |
| POST | `/api/fleet/logout` | Cierra sesión: revoca todos los tokens de esa cuenta (204) |
| GET | `/api/fleet/positions` | Flota de la empresa del token |
| GET / POST | `/api/fleet/routes` | Catálogo de rutas / alta `{ routeId, name }` |
| PATCH / DELETE | `/api/fleet/routes/:routeId` | Renombrar `{ name }` / borrar |
| POST | `/api/fleet/buses` | Alta `{ placa, routeId, interno?, tipologia?, capacidad? }` |
| PATCH / DELETE | `/api/fleet/buses/:busId` | Editar `{ placa?, routeId?, interno?, tipologia?, capacidad? }` / borrar |
| DELETE | `/api/fleet/buses?confirm=<companyId>` | Borrar toda la flota |
| POST | `/api/fleet/buses/:busId/visibility` | `{ visible }` de un bus |
| POST | `/api/fleet/buses/visibility` | `{ visible }` de todos los buses de la empresa |

Cada empresa solo ve y toca lo suyo: un bus o una ruta de otra empresa
responde 404, igual que uno que no existe, y dar de alta una placa ajena
responde `409 BUS_TAKEN` sin decir de quién es. El `routeId` de un bus
(alta o edición) tiene que estar en el catálogo de rutas de la empresa: si
no, `404 ROUTE_NOT_FOUND`, sea de otra empresa o no exista. Reenviar en la
edición la ruta que el bus ya tiene no cuenta como cambio.

Formatos y límites (400 si no se cumplen):

- `placa`: 3 letras + 3 números (`ABC123`); el bus queda como `BUS-ABC123`.
- `tipologia`: `SENCILLO`, `PADRON` o `ARTICULADO` (lista cerrada). Sin ella se asume `SENCILLO`.
- `capacidad`: aforo aprox. del bus, sentados + de pie, entero de 1 a 300. Sin ella vale el ejemplo de su tipología (30/60/80). Cada bus guarda el suyo.
- `routeId`: grupos alfanuméricos separados por guiones, de 2 a 20 caracteres
  (`R-101`). En la edición, `""` deja el bus sin ruta.
- `name` de ruta: hasta 60 caracteres. `interno`: hasta 12.
- Topes por IP y minuto: 20 altas y renombres, 60 del resto de escrituras,
  120 lecturas.

## WebSocket (Socket.IO)

Conectar en `http://localhost:3000` con `path: '/ws'`. El panel manda su
token de administrador en `auth: { token }`; el pasajero no manda nada.

| Evento | Dirección | Payload |
|--------|-----------|---------|
| `subscribe:route` | Cliente → Servidor | `routeId: string` |
| `unsubscribe:route` | Cliente → Servidor | `routeId: string` |
| `subscribe:fleet` | Panel → Servidor | — (exige token de administrador) |
| `positions:batch` | Servidor → Cliente | `{ routeId, buses }` al suscribirse |
| `positions:update` | Servidor → Cliente | `{ routeId, buses }` cuando varios buses se mueven a la vez |
| `bus:position` | Servidor → Cliente | Posición de un bus |
| `bus:left` / `bus:removed` / `bus:hidden` | Servidor → Cliente | `{ busId, routeId, eventId }` |
| `bus:visible` | Servidor → Cliente | `{ busId, routeId, eventId, position }` |
| `fleet:batch` | Servidor → Panel | `{ companyId, buses }` al suscribirse a la flota |

Las posiciones que recibe el pasajero no llevan teléfono ni empresa.

Límites por conexión:

- `subscribe:route` solo acepta rutas que existen; lo demás se ignora sin respuesta.
- Hasta 12 rutas a la vez; la decimotercera se ignora.
- Hasta 30 eventos cada 10 s; quien los supera queda desconectado.
- Mensajes de hasta 16 KB; uno mayor cierra la conexión.
- Cualquier evento fuera de los tres de arriba desconecta.

## MQTT

TCP en `mqtt://127.0.0.1:8883` (solo loopback salvo `MQTT_HOST`) o por
WebSocket en el mismo servidor HTTP, ruta `/mqtt`. Usuario: el `phoneNumber`
provisionado; contraseña: el `token` de `/api/auth/login`.

El equipo publica solo en su propio tópico, `empresa/{companyId}/bus/{busId}/posicion`
(publicar en otro corta la conexión), con JSON de hasta 256 KB:

```json
{
  "protocolVersion": 1,
  "sequence": 42,
  "capturedAt": 1757500000000,
  "lat": 10.965,
  "lon": -74.801,
  "speedKmh": 35,
  "heading": 45,
  "sentido": "ida"
}
```

`sequence` es un entero creciente por sesión y `capturedAt` la hora de
captura en milisegundos. Se rechazan coordenadas fuera de rango, velocidades
de más de 120 km/h (declaradas o calculadas entre dos puntos) y capturas del
futuro o de hace más de 15 minutos.

Suscrito a `empresa/{companyId}/bus/{busId}/ack`, el equipo recibe por cada
posición `{ protocolVersion: 1, sequence, accepted, reason? }`.

## Scripts

| Script | Uso |
|--------|-----|
| `scripts/simulate-bus.mjs` | Un bus simulado que se provisiona, inicia sesión y publica por MQTT |
| `scripts/demo-buses.sh` | Levanta varios simuladores |
| `scripts/crear-admin-empresa.mjs` / `borrar-admin-empresa.mjs` | Cuentas de panel |
| `npm run backup` | Copia de la base SQLite a un destino concreto |
| `npm run respaldo` | Copia por hora con poda (48 horarias, 30 diarias) |
| `npm run respaldo:probar` | Abre la última copia y la compara con la base viva |

## Pruebas

```bash
npm run build && npm test
```

`npm test` necesita la build: una de las pruebas arranca `dist/index.js`.
