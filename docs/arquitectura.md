# Arquitectura — Ya Viene

Cómo viaja una posición desde la antena del bus hasta el mapa del pasajero,
y qué contrato tiene cada salto. Para quien va a tocar el backend y necesita
saber por dónde pasa lo que está cambiando.

Lo que hay al lado: [`integracion-gps.md`](integracion-gps.md) es el contrato
visto desde el equipo del bus, [`runbook.md`](runbook.md) es qué hacer cuando
algo se cae, y `docs/decisiones/` guarda por qué el sistema es así y no de
otra forma.

## El camino de una posición

```
equipo GPS del bus
  │  MQTT sobre WSS  ·  empresa/<companyId>/bus/<busId>/posicion
  ▼
broker (aedes)                 tres candados: token, sesión, topic propio
  │  ack por MQTT  ·  empresa/<companyId>/bus/<busId>/ack
  ▼
validación                     formato (payload.ts) y física (physics.ts)
  │
  ▼
SQLite (positions)             una fila por bus, siempre la última
  │
  ├──────────────► socket.io  ·  al instante, a quien esté mirando esa ruta
  │
  └─ cola lifecycle_events ──► socket.io  ·  lo que no es una posición
       (barrido cada 10 s, despacho cada 250 ms)
```

Las posiciones no pasan por la cola: van directas al socket. La cola es para
los avisos de ciclo de vida —un bus que se queda sin señal, uno que la
empresa esconde, uno que se borra—, que son los que no pueden perderse
porque nadie los va a repetir.

## 1. El equipo publica

Todo el contrato está en [`integracion-gps.md`](integracion-gps.md). Lo que
importa aquí es que la ingesta por HTTP **no existe**: `POST /api/gps`
contesta `410 HTTP_GPS_DISABLED`. La única entrada es MQTT autenticado.

El broker es `aedes` montado sobre el mismo servidor HTTP, en la ruta
`/mqtt`. El puerto MQTT por TCP (`8883`) queda atado a `127.0.0.1`; sacarlo
de ahí sin certificado y llave hace que el servidor se niegue a arrancar.

Antes de los candados, una guardia (`src/mqtt/guardia.ts`) corta lo que
no hace falta autenticar para rechazar: un paquete que anuncia más de
16 KB, una conexión que no manda CONNECT en 10 s y, en `/mqtt`, más de 20
conexiones sin autenticar desde la misma dirección (`429` en el upgrade).
Como en todos los topes por dirección (`requestKey`), una IPv6 cuenta por
su /64.

Tres candados, en `src/mqtt/broker.ts`:

1. **Token.** La contraseña MQTT es el JWT de `POST /api/auth/login`. Sin
   `role: 'driver'` no se entra.
2. **Sesión.** Un bus, una sesión. La sesión nueva desplaza a la anterior;
   una sesión revocada deja de poder publicar en el acto, no al expirar el
   token.
3. **Topic propio.** Solo `empresa/<su empresa>/bus/<su bus>/posicion`.
   Publicar en otro cierra la conexión y queda en el registro. Suscribirse,
   solo al propio `ack`.

## 2. Se valida

En dos capas, y en este orden (`src/index.ts`, el manejador que recibe
`startBroker`):

| Capa | Dónde | Qué mira |
|------|-------|----------|
| Formato | `src/security/payload.ts` | Que cada campo exista, sea del tipo que dice ser y esté en su rango. |
| Catálogo | `src/data/positions_store.ts` | Que el bus siga dado de alta (`BUS_NOT_FOUND`). |
| Duplicado | `src/index.ts` | `sequence` repetido o menor dentro de la misma sesión. |
| Física | `src/security/physics.ts` | Reloj, zona de servicio y velocidad calculada contra la anterior. |

El resultado de las cuatro es un solo objeto —`accepted`, `sequence`,
`reason`— que se convierte en el ack. El equipo se entera de todo lo que le
pasa a cada posición por ese único canal.

La zona (`src/security/zona.ts`) es la misma caja que dibuja el mapa de la
app del pasajero, y `tests/zona.test.ts` lo comprueba contra el archivo
Dart. No es coincidencia: un bus fuera de esa caja no se podría ver aunque
se aceptara.

## 3. Se guarda

SQLite en modo WAL, un solo archivo (`data/yaviene.db`). Las tablas que
importan para este camino:

| Tabla | Qué guarda |
|-------|------------|
| `positions` | **Una fila por bus**, la última posición. No es un historial. |
| `buses` | El catálogo: placa, interno, ruta, si está visible. |
| `driver_sessions` | La sesión viva de cada bus y su estado de revocación. |
| `lifecycle_events` | La cola de avisos (ver abajo). |
| `empresas`, `empresa_admins`, `company_routes` | Empresas, paneles y rutas. |
| `schema_migrations` | Hasta qué versión está migrada esta base. |

`positions` tiene una fila por bus a propósito: lo que el pasajero necesita
es dónde está el bus ahora, y un historial creciendo sin tope en el disco
del Mac que sirve la demo es un problema de operación sin nadie que lo lea.

La base **se abre la primera vez que alguien la pide** (`getDb()` en
`src/data/database.ts`), no al arrancar. Eso importa al escribir guiones:
`/api/ready` contesta sin tocarla, así que un script que arranca el backend
y escribe en la base directamente puede encontrarse un archivo vacío si no
hizo antes alguna lectura por HTTP.

## 4. Se reparte

Socket.io en la ruta `/ws` (`src/socket/handler.ts`). Dos clases de sala:

| Sala | Quién entra | Qué recibe |
|------|-------------|------------|
| `route:<routeId>` | la app del pasajero, con `subscribe:route` | los buses de esa ruta |
| `admin:<companyId>` | el panel, con su token de admin | todos los buses de su empresa |

Lo que sale por cada una **no es lo mismo**: al pasajero se le quita el
teléfono del conductor y el identificador de empresa (`toPublicPosition`).
El panel sí los ve, porque son suyos.

La foto de una ruta (`positions:batch` y `GET /api/routes/:routeId/positions`,
las dos con `getPositionsByRoute`) solo trae buses de la empresa dueña de la
ruta: un bus ajeno que haya quedado en ella no sale. Una ruta que no está
en ningún catálogo no tiene dueña y trae los buses que tenga.

Eventos que emite el servidor:

| Evento | Cuándo |
|--------|--------|
| `positions:batch` | al suscribirse a una ruta: lo que hay ahora mismo |
| `fleet:batch` | al suscribirse a la flota: la empresa entera |
| `bus:position` | una posición nueva (o una que vuelve de «sin señal») |
| `positions:update` | varias posiciones de la misma ruta en la misma ventana |
| `bus:left`, `bus:hidden`, `bus:visible`, `bus:removed` | avisos de la cola |

Todo lo que sale lleva `emittedAt`: el milisegundo en que el servidor lo
mandó. Las apps lo usan para medir cuánto tardó en llegarles.

Tres topes por socket, por si alguien no viene a mirar buses: 12 rutas a la
vez, 30 eventos cada 10 segundos y solo tres eventos permitidos
(`subscribe:route`, `unsubscribe:route`, `subscribe:fleet`). Cualquier otro
cierra la conexión.

Y una ventana de agrupación de **100 ms**: lo que se emite a una sala se
junta y se manda una vez, quedándose con la última posición de cada bus.
Publicar más rápido que eso no llega a nadie.

El token del panel se vuelve a mirar **cada minuto** mientras está
conectado. Sin eso, un panel ya dentro de su sala seguía recibiendo la flota
aunque el token caducara o le cambiaran la contraseña desde otro proceso.

## 5. La cola de avisos

`lifecycle_events` es una bandeja de salida (`src/data/lifecycle_events.ts`,
`src/data/despacho.ts`). Funciona así:

- El **barrido**, cada 10 s, marca «sin señal» al bus que lleva 5 minutos
  callado y encola el aviso. El bus no desaparece del mapa: conserva su
  última posición, marcada como vieja.
- El **despacho**, cada 250 ms, saca un lote, lo emite y lo marca entregado.
- Un evento que falla 5 veces se marca muerto y sale de la cola. Sin ese
  techo, un evento venenoso se reclamaba y fallaba en bucle para siempre.
- Una reclamación que lleva 30 s sin cerrarse se considera abandonada y otro
  la puede tomar: así un backend que se cae a mitad de un lote no se lleva
  los eventos con él.
- Los entregados se purgan a la semana, los muertos al mes.

El despacho tiene un filtro propio: si un aviso de «sin señal» sale de la
cola cuando el bus ya volvió a publicar, **se descarta**. Sin él, el aviso
viejo llegaba detrás de la posición viva y el pasajero veía en gris un bus
que acababa de reportar.

## Los otros dos clientes

| Cliente | Qué es | Cómo habla |
|---------|--------|------------|
| `app_pasajero` | Flutter, Android e iOS | REST para el catálogo, socket para las posiciones. Sin cuenta. |
| `app_control` | Flutter, macOS y Windows | `POST /api/admin/login`, después REST y socket con el token. |
| `YaVieneWeb` | la landing | no habla con el backend: su mapa es una simulación, rotulada. |

## Las tres cosas que más sorprenden

1. **No hay app de conductor y no va a haberla.** El GPS es hardware montado
   en el bus. Lo que queda en el código con nombre de conductor —la tabla
   `drivers`, `driver_sessions`, el `role: 'driver'` del token— es la
   credencial del equipo, no de una persona.
2. **Una desconexión no borra el bus.** Se queda donde estaba y pasa a «sin
   señal» a los 5 minutos. Un bus quieto en un trancón no tiene posición
   nueva que mandar y no por eso está apagado.
3. **La distancia, no el tiempo.** Las apps enseñan a cuánto está el bus, no
   en cuántos minutos llega. No hay modelo de tráfico detrás que sostenga un
   número de minutos, y uno inventado se convierte en una promesa incumplida
   en el andén.
