# Auditoría del backend — septiembre de 2026 (sesión en la nube)

Auditoría de solo lectura sobre `main` en `fa97c3f` (2026-09-29). No cambia
código: cada hallazgo trae dónde está, cómo comprobarlo y el arreglo
propuesto, para que se abra como tarea aparte con su prueba roja→verde.

## Alcance

- **Leído entero:** `src/` (26 archivos, unas 6 000 líneas), `Dockerfile`,
  `fly.toml`, `docker-compose.yml`, `scripts/servicio/arrancar-backend.sh`,
  `scripts/respaldar.mjs`, `scripts/crear-admin-empresa.mjs` y
  `scripts/borrar-admin-empresa.mjs`.
- **Fuera:** `local.env` y cualquier secreto, el backend vivo, ngrok, Fly, y
  los repos de la app y la web.
- **Comprobado a mano:** los tres hallazgos marcados «Comprobado» se
  reprodujeron en una base temporal y con un backend propio en
  `127.0.0.1`, con puertos que no usa nada más. Los scripts quedaron fuera
  del repo. Lo demás sale de leer el código y lleva la forma de comprobarlo.

Gravedad:

- **P0:** hay que parar y arreglarlo ya.
- **P1:** grave. Se puede explotar desde fuera o rompe el aislamiento entre
  empresas.
- **P2:** riesgo real, pero acotado o con condiciones.
- **P3:** endurecimiento, higiene o documentación.

## Resumen

| Gravedad | Hallazgos |
|---|---|
| P0 | 0 |
| P1 | 2 |
| P2 | 5 |
| P3 | 11 |
| **Total** | **18** |

Los cinco más importantes:

1. **P1-1:** un solo cliente anónimo en `/mqtt` hace crecer la memoria del
   backend en cientos de MB.
2. **P1-2:** una empresa puede meter sus buses en las rutas de otra.
3. **P2-1:** volver a provisionar un conductor cambia el bus de empresa, y la
   caché sigue diciendo la vieja.
4. **P2-3:** el PIN del conductor es de 4 dígitos y no hay tope por cuenta.
5. **P2-4:** el backend público principal (Mac + ngrok) se revisa con
   criterio de desarrollo.

---

## P1 — graves

### P1-1. MQTT por WebSocket: memoria sin tope antes de autenticar

**Dónde:**

- `src/mqtt/broker.ts:334-345`: el `upgrade` de `/mqtt` entrega el stream a
  aedes sin límite de paquete.
- `src/mqtt/broker.ts:128`: `new aedes()` va sin opciones.

**Qué pasa:**

- `maxPayload: 256 KB` limita cada mensaje WebSocket, no cada paquete MQTT.
  El parser de aedes (`mqtt-packet`) junta en memoria el paquete entero que
  anuncia la cabecera, hasta 256 MB.
- Todo eso ocurre antes del `CONNECT`, así que no hace falta token.
- Tampoco hay tope de conexiones MQTT por IP. Cada conexión sin `CONNECT`
  vive 30 s (`connectTimeout` de aedes).
- `/mqtt` es público: está detrás de ngrok y de Fly.
- La máquina de Fly tiene 512 MB (`fly.toml`), así que dos o tres conexiones
  la tumban.

**Comprobado:**

- Se levantó un backend propio en `127.0.0.1:3991` y se abrió un WebSocket a
  `/mqtt`.
- Se mandó `0x10` + largo de 200 MB y luego 150 MB en trozos de 256 KB.
- En 8 s el RSS pasó de **106 a 275 MB**, y el socket seguía abierto.

**Cómo comprobarlo:** el mismo guion con `ws`, midiendo `VmRSS` en
`/proc/<pid>/status`. Una prueba en `tests/` puede exigir que la conexión se
cierre antes de pasar de N KB.

**Arreglo propuesto:**

1. Entre `createWebSocketStream(ws)` y `broker.handle`, un `Transform` que
   lea la cabecera fija de cada paquete MQTT (tipo + largo restante) y
   destruya el socket si el largo pasa de un tope. 16 KB sobra: el payload
   real es un JSON de menos de 1 KB.
2. Un tope de conexiones `/mqtt` por IP con `requestKey`, igual que
   `socketsPorIp` en `src/socket/handler.ts:38-42`.
3. Un `connectTimeout` de unos 5 s en `new aedes({ connectTimeout })`.
4. La prueba roja→verde: un cliente que anuncia un paquete grande queda
   desconectado y la memoria no crece.

### P1-2. Una empresa puede poner sus buses en las rutas de otra

**Dónde:**

- `src/data/fleet_admin.ts:202`: el alta solo mira la forma de la ruta
  (`isRouteId`).
- `src/api/routes.ts:746`: la edición, igual.
- `src/data/positions_store.ts:86`: la posición toma la ruta del catálogo del
  bus.
- `src/data/positions_store.ts:155-163`: `getPositionsByRoute` no filtra por
  empresa.

**Qué pasa:**

- Las rutas son de una sola empresa desde la migración 20, pero el bus no.
- Con su token de panel, la empresa B hace `POST /api/fleet/buses` o
  `PATCH /api/fleet/buses/:id` con `routeId: "R-101"`, que es de Sobusa.
- Sus posiciones salen entonces en la sala `route:R-101` y en
  `GET /api/routes/R-101/positions`, en el mapa de los pasajeros de Sobusa.
- De paso, `GET /api/fleet/routes` de B lista `R-101` con el nombre que le
  puso Sobusa (`routes_store.ts:78`).

**Comprobado** (stores directos sobre una base temporal sembrada):

- `createBus('EMP-02', 'ZZZ999', 'R-101')` devuelve el bus con
  `routeId: R-101`.
- Tras una posición, `getPositionsByRoute('R-101')` da
  `['BUS-ZZZ999(EMP-02)']`.
- `getCompanyRoutes('EMP-02')` da `R-101=B18 Tcherassi`.

**Cómo comprobarlo:** en `tests/fleet.test.ts`, una empresa B con su admin da
de alta un bus con la ruta de A y se exige 400/404.

**Arreglo propuesto:**

- En `createBus` y `updateBus`, exigir que `routeId` esté en `company_routes`
  de la empresa del bus. Si no está, 400 `INVALID_ROUTE`, sin decir de quién
  es.
- Como segunda barrera, que `getPositionsByRoute` una `company_routes` y solo
  devuelva buses cuya empresa sea la dueña de la ruta.
- La provisión con `ADMIN_API_KEY` (`routes.ts:279-298`) debería pasar por la
  misma regla.

---

## P2 — riesgo real, acotado

### P2-1. Re-provisionar un conductor cambia el bus de empresa y la caché no se entera

**Dónde:**

- `src/data/drivers_store.ts:43-50`: `ON CONFLICT(bus_id) DO UPDATE SET
  company_id`.
- `src/data/fleet_admin.ts:59-69`: `busCompanyCache` guarda también los «no
  está».

**Qué pasa:**

- `POST /api/admin/drivers` con un `busId` que ya es de otra empresa se lo
  pasa a la nueva sin avisar. Es el mismo «robo silencioso» que `createBus`
  ya cierra con `'taken'`.
- Además no toca `busCompanyCache`. Hasta reiniciar, la empresa vieja sigue
  pasando `getBusCompanyId(busId) === auth.companyId` en
  `routes.ts:503, 732, 787`, así que puede ocultar, editar o borrar un bus
  que ya no es suyo.
- Al revés también falla: un bus consultado antes de existir queda en caché
  como «sin empresa», y su panel recibe 404.
- Exige la clave global, por error o por abuso, pero la caché miente de
  verdad.

**Comprobado:**

- Bus `AAA111` dado de alta en `EMP-01`.
- `registerDriver(..., { companyId: 'EMP-02', busId: 'BUS-AAA111' })`.
- Después, la base dice `EMP-02` y la caché dice `EMP-01`.

**Arreglo propuesto:**

- En `registerDriver`, si el bus ya existe en otra empresa, rechazar con 409
  como `createBus`, en vez de pisar `company_id`.
- En todo caso, `busCompanyCache.set(busId, companyId)` después de la
  transacción.
- Prueba: provisionar sobre un bus ajeno da 409, y la empresa dueña sigue
  pudiendo editarlo.

### P2-2. Los límites por IP cuentan cada dirección IPv6 entera

**Dónde:**

- `src/security/rate_limiter.ts:318-338`: `requestKey`.
- `src/socket/handler.ts:240`: el tope de sockets usa la misma clave.

**Qué pasa:**

- La clave es la dirección completa. Un cliente IPv6 suele tener un /64
  entero, 2^64 direcciones.
- Cambiando de dirección en cada intento, se salta todo: el login (5 y 20 por
  minuto), las lecturas públicas (120 por minuto), los 100 sockets por IP y
  el tope nuevo de P1-1.
- Detrás de ngrok o de Fly la IP real viaja en `X-Forwarded-For` o en
  `Fly-Client-IP`, así que también puede llegar como IPv6.

**Cómo comprobarlo:** una prueba unitaria de `requestKey` con dos
`Fly-Client-IP` del mismo /64 y `FLY_APP_NAME` puesto. Hoy dan dos claves
distintas.

**Arreglo propuesto:**

- Normalizar la IPv6 a su prefijo /64 dentro de `requestKey`, antes de añadir
  el sufijo.
- Las IPv4 y las IPv4 mapeadas quedan como están.

### P2-3. PIN de conductor corto y sin tope por cuenta

**Dónde:**

- `src/api/routes.ts:288`: el PIN admite 4 dígitos (`^\d{4,8}$`).
- `src/api/routes.ts:318-324`: el login cuenta por IP y por (IP, teléfono).
- `fly.toml:35`: el PIN de la flota demo va escrito en el repo, con 4
  dígitos.
- `src/demo/flota_demo.ts:52-59`: los teléfonos de la demo, también.

**Qué pasa:**

- 10 000 PIN posibles y ningún límite que sume los intentos contra una misma
  cuenta desde IP distintas. Con P2-2 las IP distintas salen gratis.
- Con el token de un conductor se publican posiciones de su bus en el mapa,
  dentro de la zona de Barranquilla.
- Además `createDriverSession` revoca la sesión del equipo legítimo.
- En Fly, que es el espejo de la demo, los buses demo tienen PIN y teléfono
  conocidos por quien vea el repo.

**Cómo comprobarlo:** en `tests/security.test.ts`, intentos contra un mismo
teléfono con `Fly-Client-IP` distintas. Hoy ninguno recibe 429 por cuenta.

**Arreglo propuesto:**

1. Un tercer limitador por teléfono solo, sin IP: por ejemplo 10 fallos por
   hora, con 429 y métrica.
2. Subir el mínimo del PIN a 6 dígitos para las altas nuevas.
3. Para Fly, el PIN demo como `fly secrets` aleatorio, no en `fly.toml`.
   Borrar la línea cuando la flota demo pase a `"0"`.

### P2-4. El backend público principal se revisa con criterio de desarrollo

**Dónde:**

- `src/config.ts:65-84`: las guardias de producción son JWT_SECRET de al
  menos 32 caracteres y ADMIN_API_KEY obligatoria.
- `scripts/servicio/arrancar-backend.sh:32`: arranca sin `NODE_ENV`.

**Qué pasa:**

- El backend que da la cara a internet es el del Mac detrás de ngrok, y no
  define `NODE_ENV=production`.
- Por eso `validateConfig` no exige el largo del JWT_SECRET, ni la
  ADMIN_API_KEY, ni orígenes CORS https.
- Esas guardias existen justo para un servidor expuesto, y hoy solo las
  cumple Fly, que es el respaldo.
- No se leyó `local.env`, por la regla de no tocar secretos: puede que los
  valores ya sean largos. Pero nada lo garantiza al arrancar.

**Cómo comprobarlo:** el dueño revisa el largo de `JWT_SECRET` y
`ADMIN_API_KEY` en `local.env` sin imprimir su valor. Por ejemplo,
`awk -F= '/^JWT_SECRET=/{print length($2)}' local.env`.

**Arreglo propuesto:** una variable explícita, por ejemplo
`YA_VIENE_EXPUESTO=1` en `local.env`. Con ella, `validateConfig` aplica las
guardias de secretos de producción, sin tocar la flota, la siembra ni
`cerrarRedLocal`. Va con su prueba en `tests/arranque.test.ts`.

### P2-5. Las copias de seguridad viven en el mismo disco que la base

**Dónde:**

- `scripts/respaldar.mjs:27`: `BACKUP_DIR` por defecto es
  `data/backups/`, junto a la base.
- `docs/runbook.md:183-185`: sacar una copia a iCloud o a una USB queda como
  paso a mano.

**Qué pasa:** si falla o se pierde el disco del Mac, se van la base y todas
sus copias. La poda y la revisión de integridad están bien, pero no hay copia
fuera de la máquina que no dependa de acordarse.

**Cómo comprobarlo:** `ls data/backups` en el Mac. No hay ningún destino
fuera del disco configurado en `scripts/servicio/respaldar.sh` ni en los
plist.

**Arreglo propuesto:**

- Un segundo destino en `respaldar.sh`: copiar la copia recién revisada a una
  carpeta sincronizada o a un disco externo, si está montado.
- Avisar en el log cuando la última copia externa pase de 24 h.
- Anotarlo en el runbook.

---

## P3 — endurecimiento e higiene

**P3-1. Enumeración por tiempo en los dos logins**

- Dónde: `src/api/routes.ts:331-335` y `397-401`.
- Qué pasa: si el teléfono o el usuario no existe, no se corre `scrypt`, y la
  respuesta sale varios ms antes. Así se sabe qué cuentas existen, dentro del
  cupo del limitador.
- Cómo comprobarlo: medir 20 logins contra una cuenta que existe y 20 contra
  una que no.
- Arreglo: correr `verifySecret` contra un hash fijo de relleno cuando no hay
  cuenta.

**P3-2. `borrar-admin-empresa.mjs` dice algo que ya no es cierto**

- Dónde: `scripts/borrar-admin-empresa.mjs:64`.
- Qué pasa: al borrar un admin imprime «Su token sigue siendo válido hasta
  que expire (8h)». Desde `isAdminTokenCurrent` (`src/data/empresas.ts:94`),
  una cuenta borrada queda fuera en la siguiente petición.
- Arreglo: corregir el mensaje, para que nadie tome medidas de más.

**P3-3. La contraseña del panel va por argumento**

- Dónde: `scripts/crear-admin-empresa.mjs:21`.
- Qué pasa: queda en el historial de la consola y se ve en `ps` mientras
  corre.
- Arreglo: leerla de la entrada estándar (sin eco) o de una variable de
  entorno.

**P3-4. La imagen de Fly corre como root**

- Dónde: `Dockerfile:36-65`, que no tiene `USER`.
- Arreglo: `USER node`, con el volumen `/app/data` escribible por ese
  usuario.

**P3-5. El teléfono del conductor llega a los paneles**

- Dónde: `src/socket/handler.ts:402, 437, 447`.
- Qué pasa: `bus:position` a `admin:{empresa}` manda `conEmision(busData)`
  con `driverPhone`. El registro ya lo esconde a propósito
  (`broker.ts:174-176`) y `getFleetPositions` no lo lleva.
- Arreglo: quitar `driverPhone` también del evento del panel.

**P3-6. Una conexión MQTT sobrevive a la caducidad de su token**

- Dónde: `src/mqtt/broker.ts:191-228`.
- Qué pasa: el token solo se mira al conectar. `authorizePublish` revisa la
  sesión, no el `exp`.
- Arreglo: guardar el `exp` en `clientAuth` y cerrar en el barrido de 5 s
  cuando venza. La app reconecta con un token nuevo.

**P3-7. `jwt.verify` sin algoritmos fijos**

- Dónde: `src/auth/tokens.ts:58-61`.
- Qué pasa: hoy es seguro con un secreto HMAC.
- Arreglo: `algorithms: ['HS256']` en `verify`, y el mismo en `sign`, cierra
  la puerta a cambios futuros de la librería o de la clave.

**P3-8. Consultas repetidas al listar rutas**

- Dónde: `src/data/routes_store.ts:78` y `103-106`.
- Qué pasa: `nombreEnCatalogo` corre una consulta por fila derivada, dentro
  de un bucle.
- Arreglo: un solo `LEFT JOIN company_routes`. Con la flota demo no se nota.

**P3-9. Crear un admin crea una empresa con su código por nombre**

- Dónde: `src/api/routes.ts:445`.
- Qué pasa: `ensureEmpresa(params.companyId)` no recibe nombre. Una empresa
  nueva sale en `GET /api/companies`, que es público, como «EMP-0X», que es
  lo que la migración 17 tuvo que limpiar. Tampoco se valida la forma de
  `companyId`.
- Arreglo: pedir `name` en el cuerpo y validar el código.

**P3-10. La provisión no valida la forma de los identificadores**

- Dónde: `src/api/routes.ts:279-291`.
- Qué pasa: `busId`, `companyId`, `routeId`, `phoneNumber` y `name` solo se
  exigen no vacíos, hasta 32 KB. Un `busId` con `/`, `+` o `#` produce un
  topic MQTT al que el equipo nunca puede publicar.
- Arreglo: las mismas formas que el resto (`isRouteId`, placa o `B-\d+`,
  teléfono numérico) y un largo máximo para el nombre.

**P3-11. El tope de concurrencia de Fly podría contar los WebSockets (a comprobar)**

- Dónde: `fly.toml:86-87`: `type = "requests"`, con `hard_limit = 250`.
- Qué pasa: si el proxy cuenta cada WebSocket abierto (socket.io y `/mqtt`)
  como una petición en curso, el cliente 251 del respaldo no entra.
- Cómo comprobarlo: con la documentación de Fly, o con una prueba de carga
  contra una app de Fly de pruebas, nunca contra la viva.
- Arreglo: si se confirma, `type = "connections"` con límites a la medida de
  la flota más los pasajeros.

---

## Lo que se revisó y está bien

Para no volver a auditarlo:

- **Aislamiento del panel:** la visibilidad, la edición y el borrado de buses
  exigen que el bus sea de la empresa del token. Sale mal solo por la caché
  de P2-1.
- **Credencial del panel:** `tv` revoca los tokens al cambiar la contraseña o
  cerrar sesión.
- **Candados MQTT:**
  - JWT de conductor al conectar.
  - Sesión única por bus.
  - `authorizePublish` deniega con `Error`, no con `null`.
  - Topic exacto.
  - Suscripción solo a su `ack`.
- **Payload MQTT:** se valida por tipo y rango (`security/payload.ts`) y pasa
  por física y zona antes de tocar la base.
- **Sockets del pasajero:**
  - Eventos permitidos por lista.
  - Presupuesto de 30 eventos cada 10 s.
  - Salas solo para rutas que existen.
  - 16 KB por mensaje.
  - Guardia de consumidores lentos.
- **HTTP:** cuerpo de 32 KB con 413 limpio, UTF-8 entero, cabeceras de
  seguridad, CORS con lista y métodos sacados de las rutas.
- **Arranque:** la validación detiene un TLS a medias, un MQTT expuesto sin
  TLS, un CORS mal escrito y un `HTTP_HOST` que no es IP.
- **Datos:**
  - `quick_check` al abrir la base.
  - Migraciones en transacción.
  - Salida de eventos (outbox) con techo de intentos y purga.
  - Apagado ordenado con volcado de métricas.
