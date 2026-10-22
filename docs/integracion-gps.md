# Integración del equipo GPS del bus — Ya Viene

Para quien programa o configura el equipo GPS que va montado en el bus. Aquí
está todo lo que el equipo necesita para publicar posiciones y entender qué
le contesta el servidor: la dirección, el topic, cada campo del mensaje con
su tipo y su rango, los ejemplos, la cadencia y el significado exacto de
cada motivo de rechazo.

El GPS es hardware del bus. No hay aplicación de conductor y no se va a
proponer ninguna: lo que se describe aquí lo hace el equipo, solo.

La ingesta por HTTP no existe: `POST /api/gps` contesta `410
HTTP_GPS_DISABLED`. La única entrada de posiciones es MQTT autenticado.

## Dirección y cifrado

| Vía | Dirección | Para qué |
|-----|-----------|----------|
| MQTT sobre WebSocket seguro | `wss://occupy-shed-squatter.ngrok-free.dev/mqtt` | **La que usa el equipo en el bus.** |
| MQTT por TCP | `127.0.0.1:8883` | Solo pruebas en la misma máquina del servidor. |

El puerto MQTT por TCP está atado a `127.0.0.1` a propósito: sale de la
máquina únicamente por WebSocket, sobre la misma conexión cifrada que sirve
la API. El equipo en la calle no tiene forma de hablarle al `8883`, y así se
evita un MQTT plano expuesto a internet. Si algún día se abre ese puerto a
otra interfaz, el servidor exige certificado y llave (`MQTT_TLS_CERT_PATH` y
`MQTT_TLS_KEY_PATH`) y se niega a arrancar sin ellos.

### Límites de la conexión

Lo que el servidor corta antes de mirar credenciales, para que un cliente
anónimo no le llene la memoria:

- **Ningún paquete MQTT puede pasar de 16 KB.** El servidor lee el largo en
  la cabecera del paquete y cierra la conexión en cuanto uno anuncia más,
  sin esperar a que llegue. Lo más grande que manda el equipo es el
  CONNECT, con el token de contraseña (unos 400 bytes); una posición no
  llega a 1 KB.
- **El CONNECT tiene que llegar dentro de 10 s** después de abrir el
  WebSocket. Si no, la conexión se cierra.
- **Una misma IP puede tener 20 conexiones abiertas sin autenticar** a la
  vez (con IPv6 cuenta el /64 entero, no cada dirección). La siguiente
  recibe `429` en el WebSocket, antes de abrirlo. Una
  conexión deja de contar en cuanto el CONNECT es aceptado, así que muchos
  equipos detrás de la misma IP de un operador móvil solo chocan aquí si
  reconectan todos en el mismo instante. El equipo que recibe `429` tiene
  que reintentar unos segundos después, como con cualquier corte.

## Credenciales

El equipo se conecta con usuario vacío y **el JWT como contraseña MQTT**. El
token se pide una vez por jornada:

```
POST /api/devices/login
Content-Type: application/json

{"identifier": "<identificador del equipo>", "secret": "<secreto del equipo>"}
```

`POST /api/auth/login` sigue disponible durante la transición y acepta el
cuerpo anterior `{ "phoneNumber": "…", "pin": "…" }` (también `busId` y
`routeId` opcionales). Ambos endpoints emiten un token con rol `device`.

La respuesta trae `token`, y dentro de él van la empresa, el bus, la ruta y
un `sessionId` nuevo. El token dura **24 horas**; pasado ese tiempo la
conexión se rechaza y hay que volver a pedirlo.

**10 PIN fallidos en una hora bloquean la línea**, vengan de la IP que
vengan: **5 minutos** la primera vez, y cada bloqueo que le sigue sin un
login correcto en medio dura el doble (10, 20, 40… minutos), **hasta 24
horas**. Mientras dure, el login responde `429` con `Retry-After`
(segundos que faltan), también con el PIN bueno. Un login correcto borra la
cuenta de fallos y la racha; volver a dar de alta la línea levanta el
bloqueo; y un día sin bloqueos la olvida. Un equipo que recibe `401` no debe reintentar en bucle con el
mismo PIN: el PIN no va a cambiar solo, y cada intento acerca el bloqueo.

Un bus tiene **una sola sesión viva**. Si el mismo bus entra otra vez, la
sesión nueva desplaza a la anterior y la vieja deja de poder publicar. Eso
es lo que permite que un equipo que se reinicia vuelva a entrar de
inmediato, sin esperar a que el servidor note que el anterior murió.

El alta del equipo (línea, PIN, empresa, bus y ruta) se hace contra
`POST /api/admin/drivers` con la clave de administración. No es algo que el
equipo pueda hacer por su cuenta. Volver a darlo de alta con otra línea o
con otro PIN vale; con un bus que ya es de otra empresa responde
`409 BUS_TAKEN` y no cambia nada.

## Topics

| Topic | Quién | Qué |
|-------|-------|-----|
| `empresa/<companyId>/bus/<busId>/posicion` | publica el equipo | la posición |
| `empresa/<companyId>/bus/<busId>/ack` | se suscribe el equipo | la respuesta a cada posición |

`companyId` y `busId` son los que vienen dentro del token. **No hay otro
topic permitido**: publicar en cualquier otro, aunque sea el de un bus
hermano de la misma empresa, cierra la conexión en el acto y queda anotado
en el registro del servidor. Lo mismo con la suscripción: la única que se
acepta es la del propio `ack`.

Ambos topics van con **QoS 0 y sin retención**. El equipo no debe pedir QoS
1 ni 2 ni marcar `retain`: el ack es lo que hace las veces de confirmación,
y una posición retenida sería una posición vieja que el servidor volvería a
repartir sin que nadie la haya vuelto a medir.

## El mensaje de posición

JSON, un objeto (no un arreglo, no `null`).

| Campo | Tipo | Obligatorio | Rango |
|-------|------|-------------|-------|
| `protocolVersion` | entero | sí | exactamente `1` |
| `sequence` | entero | sí | ≥ 1, creciente dentro de la sesión |
| `capturedAt` | entero | sí | milisegundos desde época (Unix), ≥ 1 |
| `lat` | número | sí | −90 a 90, y dentro de la zona de servicio |
| `lon` | número | sí | −180 a 180, y dentro de la zona de servicio |
| `speedKmh` | número | no | 0 a 120 |
| `heading` | número | no | 0 a 360 (360 excluido) |
| `sentido` | texto | no | `"ida"` o `"venida"` |

Detalles que cuestan un rechazo si se pasan por alto:

- `capturedAt` es **cuándo se midió la posición**, no cuándo se publicó. Es
  la diferencia entre las dos cosas la que permite reenviar lo que se
  guardó sin señal.
- `sequence` cuenta por sesión. Al pedir token nuevo se puede volver a
  empezar en 1; dentro de una misma sesión nunca puede repetirse ni
  retroceder.
- `speedKmh` puede omitirse: el servidor calcula la velocidad con la
  distancia y el tiempo contra la posición anterior. Si se manda, se manda
  medida, no estimada.
- `heading` fuera de rango **no tumba la posición**: se descarta ese campo y
  el resto entra. Es el único campo que se perdona.
- Cualquier campo de más se ignora en silencio.

## Bus en terminal y visibilidad

El equipo publica con normalidad aunque el bus esté detenido en un terminal:
mantiene MQTT y sigue enviando `lat`, `lon`, `capturedAt` y `sequence`. El
backend no confunde la espera con desconexión. Oculta el bus a pasajeros
cuando confirma quietud en el tramo terminal según progreso de ruta, y lo vuelve
a mostrar al salir del radio de histéresis. La empresa lo sigue viendo en el panel con `visible: false` y
`enTerminal: true`; el evento de socket del panel también incluye esa marca.
El evento del pasajero no agrega campos y debe tratar `bus:hidden` como bus
que ya no está. La caducidad vigente marca sin señal a un GPS que deja de reportar.
La entrada usa 100 m y dos muestras quietas separadas por al menos 1 s; la
salida usa 120 m y dos muestras consecutivas con progreso creciente. La llegada solo cuenta si la proyección del GPS está en el
último 5 % del trazado; una parada cerca del terminal en mitad de la ruta no
se oculta. Para rutas circulares se conserva la fracción proyectada entre
publicaciones y reinicios. Si `sentido` falta, el servidor lo infiere de la
fracción entre posiciones consecutivas; mientras no tenga evidencia suficiente,
mantiene el bus visible.

Sin ruta asignada, el equipo no crea una posición para pasajeros y el panel
conserva el bus hasta asignarla. Con ruta asignada pero geometría inválida, la
política falla abierta y no adivina dónde ocultarlo. Cambiar de ruta reinicia
la evidencia acumulada de la ruta anterior. Detalles y radios: [D16](decisiones/D16-visibilidad-terminal.md).

### Zona de servicio

Toda posición tiene que caer dentro del área metropolitana de Barranquilla:

```
latitud   10.79    a  11.164
longitud  -75.0035 a  -74.6251
```

Es la misma caja que dibuja el mapa de la aplicación del pasajero. Una
posición fuera de ahí no se podría ver aunque se aceptara, así que se
rechaza desde la primera de la sesión. Un equipo mal configurado, uno
robado o una prueba apuntando por error al servidor de verdad se caen en
este filtro.

### Ejemplo válido

```json
{
  "protocolVersion": 1,
  "sequence": 128,
  "capturedAt": 1789267456123,
  "lat": 10.9878,
  "lon": -74.7889,
  "speedKmh": 34.5,
  "heading": 271.4,
  "sentido": "ida"
}
```

### Ejemplos inválidos y qué contesta cada uno

```json
{"protocolVersion": 2, "sequence": 5, "capturedAt": 1789267456123,
 "lat": 10.9, "lon": -74.8}
```
→ `UNSUPPORTED_PROTOCOL_VERSION`. Hoy la única versión es la 1.

```json
{"protocolVersion": 1, "sequence": "5", "capturedAt": 1789267456123,
 "lat": 10.9, "lon": -74.8}
```
→ `INVALID_SEQUENCE`, y **sin ack**: el ack se identifica por `sequence`, y
aquí no hay ninguno legible que devolver. Va como número, no como texto.

```json
{"protocolVersion": 1, "sequence": 6, "capturedAt": 1789267456,
 "lat": 10.9, "lon": -74.8}
```
→ `CLOCK_DRIFT_EXCEEDED`. Eso son **segundos**: el servidor lo lee como
milisegundos y le sale una fecha de 1970. `capturedAt` va en milisegundos.

```json
{"protocolVersion": 1, "sequence": 7, "capturedAt": 1789267456123,
 "lat": 4.7110, "lon": -74.0721}
```
→ `FUERA_DE_ZONA`. Bogotá no es el área metropolitana de Barranquilla.

```json
{"protocolVersion": 1, "sequence": 8, "capturedAt": 1789267456123,
 "lat": 10.9, "lon": -74.8, "speedKmh": 145}
```
→ `INVALID_REPORTED_SPEED`. El tope es 120 km/h.

## La respuesta: el ack

Por cada posición publicada el servidor contesta una vez en el topic de
`ack`, con este objeto:

```json
{
  "protocolVersion": 1,
  "sessionId": "9d2f…",
  "sequence": 128,
  "accepted": true,
  "receivedAt": 1789267456481
}
```

`reason` solo aparece cuando hay algo que decir. `sequence` es el de la
posición que se está contestando: así el equipo sabe a cuál corresponde sin
llevar la cuenta del orden de llegada.

Hay mensajes que **no reciben ack**: los que no son JSON válido y los que no
traen un `sequence` legible. El ack se identifica por el `sequence` de la
posición que contesta; sin él no hay nada que devolver. Si el equipo publica
y no recibe nada, el problema está en el formato del mensaje, antes de
cualquier regla de negocio.

### Motivos, uno por uno

Aceptadas (`accepted: true`):

| `reason` | Qué pasó | Qué hacer |
|----------|----------|-----------|
| *(ausente)* | Entró y ya está en el mapa de los pasajeros. | Seguir. |
| `DUPLICATE` | Ese `sequence` ya había entrado en esta sesión. | Nada. No reintentar: se dio por buena. |

Rechazadas (`accepted: false`). Las cinco primeras son del formato del
mensaje; las demás, de lo que dice el mensaje:

| `reason` | Qué pasó |
|----------|----------|
| `INVALID_PAYLOAD` | No es un objeto JSON (llegó un arreglo, un `null`, un número). *Sin ack.* |
| `UNSUPPORTED_PROTOCOL_VERSION` | `protocolVersion` no es `1`. Sin ack si además el `sequence` es ilegible. |
| `INVALID_SEQUENCE` | Falta, no es entero o es menor que 1. *Sin ack.* |
| `INVALID_CAPTURE_TIME` | Falta, no es entero o es menor que 1. |
| `INVALID_COORDINATES` | `lat`/`lon` faltan, no son números finitos o se salen de −90/90 y −180/180. |
| `INVALID_REPORTED_SPEED` | `speedKmh` no es número, es negativa o pasa de 120 km/h. |
| `BUS_NOT_FOUND` | El bus ya no está en el catálogo de la empresa. La sesión no sirve; no insistir. |
| `FUTURE_CAPTURE_TIME` | `capturedAt` va más de 30 s adelante del reloj del servidor. |
| `CLOCK_DRIFT_EXCEEDED` | `capturedAt` va más de 15 min atrás del reloj del servidor. |
| `FUERA_DE_ZONA` | La posición cae fuera del área metropolitana. |
| `OUT_OF_ORDER_CAPTURE` | `capturedAt` no es posterior al de la posición anterior de esta sesión. |
| `NO_CAPTURE_TIME_DELTA` | Dos posiciones con exactamente el mismo `capturedAt`. |
| `SANITY_REJECTED` | La velocidad **calculada** contra la posición anterior pasa de 120 km/h: el bus habría saltado. |

Un rechazo no cierra la conexión. Lo que sí la cierra, sin ack de por medio,
es publicar en un topic ajeno, publicar sin token válido o publicar con una
sesión que otro equipo ya reclamó.

## Cadencia

Una posición cada **5 a 15 segundos** mientras el bus se mueve.

Los límites de los dos lados:

- El servidor agrupa lo que reparte a los pasajeros en ventanas de 100 ms y
  se queda con **la última posición de cada bus** en cada ventana. Publicar
  más de diez veces por segundo no le llega a nadie: se pierde en el camino.
- Un bus que lleva **5 minutos** sin publicar pasa a «sin señal» en el mapa.
  No desaparece —conserva su última posición— pero se le marca como vieja.

Un bus quieto (semáforo, trancón) no tiene posición nueva que mandar. Es el
único caso en el que conviene publicar igual de vez en cuando, antes de esos
5 minutos, para no marcarse sin señal estando en servicio.

## Reloj desajustado

El servidor compara `capturedAt` con su propia hora y tolera:

- **30 segundos hacia adelante.** Más que eso es `FUTURE_CAPTURE_TIME`. La
  ventana es corta a propósito: una posición del futuro envenena el cálculo
  de velocidad de las siguientes.
- **15 minutos hacia atrás.** Más que eso es `CLOCK_DRIFT_EXCEEDED`. Esa
  ventana es la que permite reenviar lo guardado sin señal, y a la vez
  rechaza un reloj manipulado para fingir un recorrido.

De ahí que el equipo deba sincronizar su reloj por NTP al arrancar y cada
cierto tiempo. Un equipo con el reloj corrido media hora no publica nada
válido, aunque el GPS funcione perfecto.

## Pérdida de red

El túnel se cae, el bus entra a una zona sin cobertura, el equipo se
reinicia. Lo que hay que hacer:

1. **Guardar las posiciones que no se pudieron mandar**, con su `capturedAt`
   real, el del momento en que se midieron.
2. Al volver la red, **reconectar y reenviar en orden**, de la más vieja a
   la más nueva, con `sequence` creciente. El orden importa: una posición
   con `capturedAt` anterior a la última que entró se rechaza con
   `OUT_OF_ORDER_CAPTURE`.
3. **Descartar lo que pase de 15 minutos.** No va a entrar, y reintentarlo
   solo gasta batería y datos.
4. Si al reconectar el token ya venció (24 h), pedir uno nuevo. La sesión
   cambia y el `sequence` puede volver a empezar en 1.

Durante el corte el bus sigue en el mapa con su última posición, marcado sin
señal a los 5 minutos. Al reenviar, los pasajeros lo ven volver a su sitio.

Un detalle del reenvío: solo la **última** posición de cada ventana de
100 ms llega a los pasajeros, así que vaciar un buffer de golpe deja el bus
donde toca, pero sin dibujar el recorrido intermedio. El recorrido sí queda
guardado. Si se quiere que se vea moverse, el vaciado va espaciado.
