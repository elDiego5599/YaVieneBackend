# Runbook de operación — Ya Viene

Qué hacer cuando algo se cae, antes y durante una demo o el piloto. Escrito
para la persona que opera el Mac donde vive el backend, no para quien programa.

Las tres carpetas son repos separados y hermanos: `YaVieneBackend` (donde vive
este documento), `YaViene` (apps Flutter y los guiones de la demo) y
`YaVieneWeb`. Los comandos de aquí se corren desde `YaVieneBackend`, salvo los
dos guiones que se dice que están en `YaViene`.

## Las piezas

| Pieza | Dónde | Cómo se llama |
|-------|-------|---------------|
| Backend | El Mac, `:3000` (HTTP, WebSocket `/ws`, MQTT sobre WebSocket `/mqtt`) y `:8883` (MQTT por TCP, atado a `127.0.0.1`) | `node dist/index.js` |
| Base | `YaVieneBackend/data/yaviene.db` (SQLite en modo WAL) | — |
| Túnel | ngrok con dominio fijo, `https://occupy-shed-squatter.ngrok-free.dev` | `ngrok start yaviene` |
| Respaldo | Fly, `https://ya-viene-backend.fly.dev` | duerme cuando no se usa |
| Apps | La dirección va compilada dentro (`--dart-define=BACKEND_URL=…`); la de respaldo viene de fábrica | `app_pasajero`, `app_control` |

La dirección del túnel no cambia entre reinicios: por eso una APK repartida
sigue sirviendo. Nada de cloudflared: da una URL distinta cada vez y obliga
a recompilar y repartir de nuevo (por eso se borró `start-test.sh`, que lo
levantaba y además mataba el backend de launchd con `pkill`).

## Arrancar

```bash
cd /Users/diegoangarita/YaViene/YaVieneBackend
npm run build
set -a && source local.env && set +a
nohup node dist/index.js </dev/null > /tmp/yaviene-backend.log 2>&1 &
```

`local.env` trae `JWT_SECRET` y `ADMIN_API_KEY`; si falta el primero, el
arranque se detiene con un mensaje `[Config]`. Este backend da la cara a
internet por ngrok, así que `local.env` lleva también `YA_VIENE_EXPUESTO=1`:
con ella el arranque exige lo mismo que en Fly para los secretos (`JWT_SECRET`
de 32 caracteres o más, `ADMIN_API_KEY` obligatoria) y orígenes CORS https,
sin abrir la red local ni apagar la flota demo, que es lo que haría
`NODE_ENV=production`. Para
desarrollo, con recarga en caliente, `make dev` hace lo mismo cargando el mismo
archivo.

**Después de tocar el código del backend hay que volver a `npm run build`
antes de reiniciar**: `node dist/index.js` corre lo compilado, y más de una vez
un `dist` viejo hizo parecer que una migración nueva fallaba.

El túnel, en otra terminal:

```bash
ngrok start yaviene --log=stdout
```

Fuera de producción el backend solo atiende a esta máquina: cualquier
conexión que llegue por la Wi-Fi se cierra al conectar, y el público entra por
ngrok. Para probar con un teléfono en la misma red sin túnel,
`HTTP_ALLOW_REMOTE=1` delante del arranque (el log lo avisa con `[Config]`).

El HTTP escucha en `::`, que en el Mac atiende IPv4 e IPv6 a la vez (el log
dice `[HTTP] Server listening on http://[::]:3000 (IPv4+IPv6)`). No se toca.
`HTTP_HOST` existe solo para máquinas sin IPv6 —el contenedor de la nube
donde corren las pruebas—, donde el arranque se cae con
`listen EAFNOSUPPORT … :::3000`; ahí `HTTP_HOST=127.0.0.1` delante del
arranque. Tiene que ser una IP, y en producción no una de loopback: el
arranque se detiene con `[Config]` si no. La suite ya la fija sola en
`127.0.0.1` (`tests/entorno.ts`).

Los buses de la demo no se arrancan a mano: el backend mantiene la plantilla de 12 buses por ruta en un proceso y temporizador compartidos: ocho rodando (cuatro por sentido), repartidos por el recorrido, y cuatro esperando en los terminales. Cuando llegan dos al mismo terminal se retiran y salen allí dos reemplazos. Los ocho iniciales arrancan inmediatamente; el simulador registra sus conductores y firma JWT dentro del proceso con `signToken`, sin usar el limitador del login público (`src/demo/flota_demo.ts`);
`YA_VIENE_FLOTA_EMPRESA=EMP-01` deja solo las seis rutas de Sobusa). Arrancan
margen para reintentos. Para apagarlos —tráfico real,
donde esas posiciones falsas viajarían por el mismo canal que las buenas—
`YA_VIENE_FLOTA_DEMO=0` delante del arranque. La flota demo firma sus JWT
dentro del backend y no necesita un PIN global. Si Fly todavía tiene ese
secreto configurado, quítalo con `fly secrets unset PIN`.

## Saber que está sano

```bash
curl -s https://occupy-shed-squatter.ngrok-free.dev/api/health   # {"status":"ok"}
curl -s https://occupy-shed-squatter.ngrok-free.dev/api/ready    # {"status":"ready"}
```

`/api/health` solo dice que el proceso vive. `/api/ready` responde 503 con
`DATABASE_NOT_READY` si la base no contesta y con `BROKER_NOT_READY` si el
broker MQTT no está listo; es el que hay que mirar cuando algo va raro.

La revisión completa, antes de cualquier demo:

```bash
cd /Users/diegoangarita/YaViene/YaViene && bash check-demo.sh
```

En unos veinte segundos comprueba que el túnel conteste `/api/ready`, que los
doce buses de R-106 publiquen por el socket (lo mismo que ve la app) y que la
base esté recibiendo posiciones frescas. En este Mac revisa además, sin
cambiar nada, el resto del tablero del día (T10.3): los cuatro servicios de
launchd, la corriente, que no se pueda dormir, una copia de menos de 2 h y
logs por debajo de 50 MB. Sale con código 1 si algo falla; `--sin-mac` revisa
solo el servidor desde otro equipo. Lo que no automatiza: abrir el panel y ver
«En línea», abrir el pasajero y ver los buses moverse, y probar el punto de
acceso del teléfono.

## Si se cae el túnel

Lo que hacen las apps solas, sin tocarlas: al arrancar preguntan por
`/api/health` a la dirección principal (espera de 3 s) y, si no contesta, al
respaldo (espera de 20 s, porque la máquina de Fly duerme y la primera petición
la despierta). Con la app ya abierta, tras **30 s sin conexión** vuelven a
preguntar, así que desde que el túnel muere hasta que el pasajero enseña buses
del respaldo pasan unos 41 s. Panel y pasajero lo dicen en una línea discreta:
«Conectado al respaldo». Una vez ahí no vuelven a la principal aunque reviva,
hasta que se cierren y se abran otra vez; así no bailan de un sitio a otro cada
vez que el túnel parpadea.

Qué hacer:

1. `ngrok start yaviene` otra vez y `bash check-demo.sh` para confirmar.
2. Como el dominio es fijo, no hay que recompilar ni repartir nada.
3. Si ngrok no levanta, el respaldo de Fly es el plan B, pero hoy **no está
   desplegado** por decisión del dueño (se despliega el día anterior a
   presentar). Sin Fly y sin túnel, la demo solo funciona contra el Mac en la
   misma red.
4. Y si lo que falta es la red del sitio entero —ni túnel, ni respaldo, ni
   datos—, no hay nada que reiniciar: se enseña la grabación y se dice lo que
   está escrito en [`contingencia-pitch.md`](contingencia-pitch.md).

## Si se cae el backend

```bash
lsof -ti :3000                      # ¿hay proceso?
tail -50 /tmp/yaviene-backend.log   # por qué se murió
```

Se arranca igual que arriba, con el mismo `local.env` y la misma base. Las apps
no necesitan ayuda: al volver el backend se reconectan y se resuscriben solas a
sus rutas, y el panel vuelve a pedir la flota.

Para ensayarlo —matar el backend, reiniciarlo con el mismo entorno y verificar
que el conjunto se recupera solo— está `bash demo-crash-recovery.sh` en
`YaViene`. Tarda menos de un minuto (espera hasta 20 s a `/api/ready` y hasta
25 s a que los simuladores vuelvan) y termina con el sistema en pie. No es para
usarlo en mitad de una demo: es el ensayo del día anterior.

## Si muchos equipos GPS reciben 429 tras un reinicio

Al volver el backend, todos los equipos reconectan a la vez. Hasta que su
CONNECT es aceptado, cada uno cuenta como conexión anónima, y una misma IP
(con IPv6, un mismo /64) puede tener **20** abiertas a la vez
(`src/mqtt/guardia.ts`). Muchos buses detrás de la IP de un mismo operador
móvil pueden chocar con ese tope: la conexión 21 recibe `429` al abrir el
WebSocket y el equipo tiene que reintentar. Se ve en las métricas:

```bash
curl -s -H "x-admin-key: $ADMIN_API_KEY" http://127.0.0.1:3000/api/metrics \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).counters["mqtt.rechazado.anonimas_ip"]))'
```

Qué hacer:

1. **Esperar uno o dos minutos.** Cada equipo sale del cupo en cuanto se
   autentica, así que los que reintentan van entrando. Si el contador deja
   de subir y los buses vuelven a verse «En línea» en el panel, no hay nada
   más que hacer.
2. **Si sigue subiendo pasados unos minutos** y los buses no vuelven —más de
   20 equipos detrás de una misma IP que reintentan todos en el mismo
   segundo—, subir el tope con `YA_VIENE_MAX_MQTT_ANONIMAS_IP` y reiniciar:

   ```bash
   echo 'YA_VIENE_MAX_MQTT_ANONIMAS_IP=60' >> local.env
   launchctl kickstart -k gui/$UID/com.yaviene.backend   # o el arranque a mano de arriba
   ```

   En Fly va en `[env]` de `fly.toml` y se aplica al desplegar.
3. Subirlo no abre la puerta a llenar la memoria: eso lo cortan el tope de
   16 KB por paquete y el plazo de 10 s para el CONNECT, que no cambian. El
   cupo solo limita cuántas conexiones mudas tiene una IP a la vez. Cuando
   pase, borrar la línea de `local.env` y volver al valor por defecto.
4. Si los `429` no coinciden con un reinicio y no hay buses caídos, no es
   una reconexión en masa sino alguien abriendo conexiones sin
   autenticarse: no se sube el tope.

### Un equipo que no puede iniciar sesión (429 en el login)

Diez PIN fallidos en una hora bloquean esa línea, vengan de donde vengan:
5 minutos la primera vez y el doble en cada bloqueo seguido, hasta 24 horas
(`login.cuenta_bloqueada` en las métricas, y una línea
`[Auth] Cuenta …1234 bloqueada N min` en el log). Varias líneas seguidas de
la misma cuenta con los minutos creciendo son un equipo que reintenta en
bucle o alguien adivinando. Si es un equipo propio mal configurado:
corregir su PIN y volver a provisionarlo con `POST /api/admin/drivers`, que
levanta el bloqueo y borra la racha; esperar sirve solo para los primeros. El bloqueo vive en memoria, así
que reiniciar el backend también lo levanta, pero si nadie tocó el equipo es
alguien probando PIN y el bloqueo está haciendo su trabajo.

## Si la base no arranca

El backend revisa la base al abrirla y se detiene si está dañada. Los dos
mensajes no significan lo mismo:

- «La base … está dañada (…). Restaura el último backup (scripts/backup-db.mjs)
  y vuelve a arrancar.» → daño real: restaurar (siguiente sección).
- «No se pudo revisar la base … Eso no dice que el archivo tenga daño: revisa
  que otro proceso no la tenga bloqueada, los permisos y el espacio en disco…»
  → **no restaurar**. Restaurar aquí perdería todo lo escrito desde la última
  copia. Mirar si quedó otro `node dist/index.js` vivo (`lsof -ti :3000`), los
  permisos del archivo y el disco.

## Copias de seguridad y restauración

Las copias las hace solo el servicio `com.yaviene.respaldo` de launchd, una
cada hora, mientras el Mac esté encendido. Cada pasada copia la base en
caliente —respaldo en línea de SQLite, no hay que parar el backend— y acto
seguido abre la copia recién hecha para comprobar que sirve: `integrity_check`
y las tablas contadas contra la base viva. Lo que salga queda en
`~/Library/Logs/YaViene/respaldo.log`.

Se instala y se carga con los otros servicios (ver «Servicios de launchd»):

```bash
bash scripts/servicio/instalar-servicios.sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yaviene.respaldo.plist
```

Dónde quedan y cuántas se guardan: `data/backups/`, con nombre
`yaviene-<AAAAMMDD>-<HHMMSS>.db` en UTC. Se conservan las **48 últimas** (dos
días de copias por hora) y, de las más viejas, **una por día hasta 30 días**.
Con la base de hoy eso ocupa unos pocos cientos de megas; los topes se cambian
con `RETENCION_HORARIOS` y `RETENCION_DIARIOS`.

A mano, sin esperar a la hora:

```bash
cd /Users/diegoangarita/YaViene/YaVieneBackend
npm run respaldo          # copia y poda
npm run respaldo:probar   # abre la última copia y la compara con la viva
```

`npm run respaldo:probar` falla —y sale distinto de cero— si no hay ninguna
copia, si la más nueva tiene más de tres horas (`MAX_EDAD_HORAS`), si no pasa
`integrity_check`, si le falta una tabla o si una tabla con datos en la base
viva sale vacía en la copia. Es la comprobación que conviene correr el día
antes de presentar.

Un disco que se muere se lleva la base y `data/backups/` a la vez, así que
cada copia revisada sale también a un segundo destino fuera del disco: una
USB o una carpeta sincronizada con iCloud, en `BACKUP_DIR_EXTERNO` dentro de
`local.env` (el servicio lo lee al correr):

```bash
echo 'BACKUP_DIR_EXTERNO=/Volumes/<USB>/yaviene-backups' >> local.env
```

La carpeta tiene que existir: si el disco no está montado no se crea (sería
otra carpeta en el mismo disco), la copia local sale igual y
`respaldo.log` lo anota. Cuando la última copia de fuera pasa de **24 h**, o
si `BACKUP_DIR_EXTERNO` no está puesto, la línea empieza por `[AVISO]`:

```bash
grep AVISO ~/Library/Logs/YaViene/respaldo.log | tail -3
```

La poda de fuera es la misma que la de dentro (48 recientes y una por día
hasta 30 días).

Restaurar, paso a paso:

```bash
# 1. Parar el backend.
kill "$(lsof -ti :3000)"

# 2. Apartar la base actual, con sus archivos de WAL.
cd /Users/diegoangarita/YaViene/YaVieneBackend/data
mv yaviene.db yaviene.db.roto; rm -f yaviene.db-wal yaviene.db-shm

# 3. Poner la copia en su lugar y comprobarla antes de arrancar.
cp backups/yaviene-<fecha>-<hora>.db yaviene.db
sqlite3 yaviene.db 'PRAGMA integrity_check;'   # debe decir: ok

# 4. Arrancar y confirmar.
cd .. && set -a && source local.env && set +a
nohup node dist/index.js </dev/null > /tmp/yaviene-backend.log 2>&1 &
curl -s http://localhost:3000/api/ready
```

Los archivos `-wal` y `-shm` se borran a propósito: pertenecen a la base vieja y
pegarlos a una copia distinta la corrompe. La base restaurada no trae las
posiciones que llegaron después de la copia; los buses vuelven a poblarla en
cuanto publiquen.

El camino entero —base sana, copia, base rota a propósito, arranque rechazado,
restauración, arranque bueno— lo corre la prueba `tests/respaldo.test.ts` en
carpetas temporales y con puertos propios, así que no hay que ensayarlo a mano
sobre la base viva.

### La base de Fly

El volumen `yaviene_data` de `ya-viene-backend` tiene los snapshots
automáticos encendidos y una retención de **5 días**:

```bash
fly volumes show vol_rkgm21mjdxk5n064          # retención y si están activos
fly volumes snapshots list vol_rkgm21mjdxk5n064
fly volumes snapshots create vol_rkgm21mjdxk5n064   # uno a mano, antes de desplegar
```

Cinco días son suficientes para una demo, pero no son un archivo: lo que haya
que conservar más tiempo se guarda desde el Mac. La base de Fly no es la del
Mac —`.dockerignore` deja `data/` fuera de la imagen a propósito—, así que
ninguna de las dos copias cubre a la otra.


## Quitarle el panel a alguien

Cambiar la contraseña sube la versión de la credencial, y eso invalida los
tokens ya emitidos:

```bash
node scripts/crear-admin-empresa.mjs <companyId> <username> - [nombre]
```

El «-» va en lugar de la contraseña: el script la pide y se teclea sin eco
(también se puede pasar por la entrada estándar o en `CLAVE_PANEL`). Escrita
en el argumento se rechaza, porque quedaría en el historial y en `ps`. La
contraseña ha de tener 12 caracteres o más. El backend revisa los paneles
conectados cada minuto, así que una sesión abierta se cae sola en menos de 60 s
y el panel muestra «Tu sesión expiró». Si en ese momento la base no responde,
la revisión deja pasar al panel y lo saca en la primera vuelta en que la base
conteste; el tope sigue siendo la caducidad del token, ocho horas.

Borrar la cuenta entera:

```bash
node scripts/borrar-admin-empresa.mjs <username>
```

Avisa y no borra si es la única cuenta de esa empresa, porque dejaría el panel
de esa empresa sin forma de entrar. Borrar también revoca: el token que esa
persona ya tiene deja de valer en su siguiente petición, y un panel abierto se
cierra en menos de un minuto, igual que al cambiar la contraseña.

Las contraseñas se teclean en el momento: no van en este documento, ni en un
script, ni en la CI.

## Sacar un bus del mapa

Desde el panel de la empresa: ocultar un bus, ocultar toda la flota o borrar el
bus. El equipo del bus puede cerrar su turno con
`POST /api/buses/:busId/offline`, que además revoca su sesión.

Los dispositivos se pueden provisionar con credencial propia mediante
`POST /api/admin/drivers`; cada equipo usa su secreto. La revocación individual
de credenciales, sin tocar los demás equipos, sigue pendiente (T4.3).

## Avisos con la app cerrada (push, Android)

El servidor avisa por Firebase Cloud Messaging cuando la app del pasajero
está cerrada ([D13](decisiones/D13-avisos-push.md)). Necesita la clave de la
cuenta de servicio de Firebase; sin ella el arranque dice
`[Push] Sin YA_VIENE_FCM_CREDENCIALES` y la app sigue avisando solo abierta.
Cada teléfono puede tener un solo bus armado a la vez; el backend rechaza
otro aviso hasta que se retire el actual o suene.

Encenderlo, una vez:

1. Consola de Firebase → Configuración del proyecto → Cuentas de servicio →
   **Generar nueva clave privada**. Baja un JSON.
2. Guardarlo **fuera del repo**, por ejemplo en
   `~/.config/yaviene/fcm-credenciales.json`, con `chmod 600`. Es una clave
   privada: no se manda por chat ni se pega en ningún lado. El `.gitignore`
   del backend tapa `fcm-credenciales*.json` y `*-firebase-adminsdk-*.json`
   por si acaso.
3. En `local.env`: `YA_VIENE_FCM_CREDENCIALES=/ruta/al/archivo.json`.
4. `npm run build` y reiniciar
   (`launchctl kickstart -k gui/$UID/com.yaviene.backend`). Si el archivo no
   se puede leer o no es la cuenta de servicio, el arranque se detiene con
   `[Config] YA_VIENE_FCM_CREDENCIALES: …` y dice qué falta, nunca lo que trae.

Saber si funciona: `/api/metrics` cuenta `push.enviados`, `push.fallidos`
(FCM caído o lento; se reintenta en la vuelta siguiente),
`push.token_invalido` (la app se desinstaló; sus avisos se borran) y
`push.tabla_llena` (10.000 avisos armados a la vez: no debería pasar nunca).
Si `push.fallidos` sube y `push.enviados` no, revisar en el log
`[Push] No hay token de acceso`: la clave se revocó en la consola y hay que
generar otra.

Un pasajero que dice que no le llegó: en Android, «Forzar detención» desde
los ajustes del teléfono bloquea todo push hasta que se vuelva a abrir la
app, y algunos fabricantes (Xiaomi, Huawei) duermen las apps en segundo
plano si no se les quita el ahorro de batería. En iPhone no llega nunca:
falta la cuenta de Apple.

## El panel en el navegador (/panel/)

El backend sirve la build web del panel en `/panel/`, en el mismo origen que
la API: por ngrok queda en `https://occupy-shed-squatter.ngrok-free.dev/panel/`.
Así la cookie del panel (SameSite=Strict) viaja y el login no pide CORS.

Ponerlo o actualizarlo:

1. En la app: `tool/compilar-panel-web.sh --base-href /panel/
   https://occupy-shed-squatter.ngrok-free.dev`. Deja la build y su
   `csp.txt` en `app_control/build/web`.
2. Copiarla **fuera del repo** a una carpeta fija (por ejemplo
   `~/.config/yaviene/panel-web`), para que la siguiente compilación no
   cambie lo que se está sirviendo: `rsync -a --delete
   app_control/build/web/ ~/.config/yaviene/panel-web/`.
3. La primera vez, en `local.env`: `YA_VIENE_PANEL_WEB=/ruta/a/panel-web`.
4. `npm run build` y reiniciar
   (`launchctl kickstart -k gui/$UID/com.yaviene.backend`). Para cambiar
   solo la build (paso 2) no hace falta reiniciar: se lee del disco en cada
   petición; la CSP sí se lee al arrancar.

Si la carpeta no existe o le falta `index.html` o `csp.txt`, el arranque
dice `[Panel] No se sirve el panel web: …`, `/panel/` da 404 y la API sigue
igual: el pasajero no se entera. Sin la variable, `/panel/` es 404.

Saber que está sano: `curl -sI localhost:3000/panel/` da 200 con
`Content-Security-Policy`. La primera visita por ngrok gratis muestra su
aviso («You are about to visit…»); se pasa una vez por navegador. ngrok
gratis va lento (unos 140 KB/s): el panel sale comprimido con gzip, 3,2 MB
en vez de 9, y después el navegador solo revalida.

## Buzón de problemas y sugerencias

Los reportes que el pasajero manda desde el menú de la app llegan al Gmail
del equipo ([D14](decisiones/D14-buzon.md)). Sin la cuenta de correo el
arranque dice `[Buzón] Sin YA_VIENE_CORREO_USUARIO/CLAVE` y los reportes se
siguen recibiendo: esperan en la tabla `reportes` hasta que se configure.

Encenderlo, una vez:

1. En la cuenta de Google que manda (con la verificación en dos pasos
   activa): Seguridad → **Contraseñas de aplicaciones** → crear una para
   «Ya Viene». Google la muestra en cuatro grupos de letras. No se manda
   por chat ni se pega en ningún otro lado.
2. En `local.env`, cada valor entre comillas simples: el arranque lo lee
   con `source` (`scripts/servicio/arrancar-backend.sh`), y una clave con
   espacios y sin comillas corta la línea en el primer espacio. El backend
   le quita los espacios a la clave, así que da igual pegarla con ellos o
   sin ellos, pero siempre entre comillas:
   - `YA_VIENE_CORREO_USUARIO=` la dirección de esa cuenta.
   - `YA_VIENE_CORREO_CLAVE=` la contraseña de aplicación.
   - `YA_VIENE_CORREO_DESTINO=` solo si los reportes van a otra dirección;
     sin ella llegan a la misma cuenta.

   Para escribirlas sin que la clave quede en pantalla ni en el historial
   de la terminal (zsh, desde la carpeta del backend):

   ```sh
   read "u?Gmail: " && read -s "c?Contraseña de aplicación: " && printf "\nYA_VIENE_CORREO_USUARIO='%s'\nYA_VIENE_CORREO_CLAVE='%s'\n" "$u" "${c// /}" >> local.env && unset c
   ```
3. `npm run build` y reiniciar
   (`launchctl kickstart -k gui/$UID/com.yaviene.backend`). Con una sola de
   las dos variables, o una dirección mal escrita, el arranque se detiene
   con `[Config] Buzón: …` y dice qué falta, nunca la clave.

Saber si funciona: `/api/metrics` cuenta `buzon.recibidos`,
`buzon.enviados`, `buzon.fallidos` y `buzon.lleno` (1.000 reportes sin
salir: Gmail lleva días rechazando). Si `buzon.fallidos` sube y
`buzon.enviados` no, el log dice el paso y el código:
`AUTH: el servidor de correo respondió 535` es la contraseña de aplicación
mal puesta o revocada; hay que crear otra. Un reporte que falla espera 1
minuto, luego 2, 4… hasta 6 horas, y sale solo cuando Gmail vuelve.

## La lista de «Avísame cuando salga»

Los celulares que deja la gente en el hero de la web
([D15](decisiones/D15-lista-lanzamiento.md)). Se guardan con la fecha y la
versión del permiso; los números no salen en ningún log.

Encenderla, cuando la web tenga su dominio: en `local.env`,
`WEB_ORIGINS='https://el-dominio-de-la-web'` (sin barra final; varios, con
coma), `npm run build` y reiniciar. Sin eso la web no puede leer la
respuesta y la persona ve «No pudimos guardar tu número». No va en
`CORS_ORIGINS`: esa lista es del panel y le da su sesión.

Leerla, desde la carpeta del backend (la clave no sale en pantalla):

```sh
(source local.env && curl -s -H "x-admin-key: $ADMIN_API_KEY" http://127.0.0.1:3000/api/admin/lanzamiento)
```

Borrar un número que lo pida (como lo escriba la persona, entre comillas):

```sh
(source local.env && curl -s -X DELETE -H "x-admin-key: $ADMIN_API_KEY" "http://127.0.0.1:3000/api/admin/lanzamiento/3001234567")
```

Tras avisar del lanzamiento, vaciarla: el mismo `DELETE` sin el número
(`/api/admin/lanzamiento`). La lista solo servía para ese aviso.

`/api/metrics` cuenta `lanzamiento.recibidos` y `lanzamiento.lleno`
(20.000 números).

## Qué ve la gente en cada caso

| Situación | Pasajero | Panel |
|-----------|----------|-------|
| Todo bien | Buses moviéndose | «En línea» |
| Túnel caído, respaldo en pie | Buses del respaldo en ~41 s y la línea «Conectado al respaldo» | Igual, con la línea en la cabecera |
| Túnel y respaldo caídos | Sigue reintentando, sin buses nuevos; el mapa y el último estado se quedan | Sin flota; «Recargar» no arregla nada hasta que vuelva |
| Backend reiniciado | Se resuscribe solo y vuelven los buses | Vuelve a pedir la flota solo |
| Bus quieto en terminal | Oculto hasta que sale; deja de aparecer también en avisos FCM | Sigue conectado; la flota REST/socket muestra `enTerminal: true` |
| Bus sin señal (5 min sin publicar) | «Bus sin señal» en la hoja, y el aviso de cercanía queda bloqueado | El bus deja de actualizarse |
| Aviso armado y app cerrada (Android) | La notificación llega por push a la distancia que eligió el pasajero, si el servidor tiene la clave de Firebase | — |
| Panel revocado | — | «Tu sesión expiró» en menos de 60 s |

Si un bus real no aparece al salir del terminal, revisar que tenga ruta
asignada y geometría válida. Una llegada debe estar proyectada en el último
5 % del trazado; una parada intermedia cerca del terminal sigue visible. Sin
geometría válida la regla automática falla abierta. Ver [D16](decisiones/D16-visibilidad-terminal.md).

## Fly, el respaldo

No se despliega hasta el día anterior a presentar: es una decisión del dueño, no
un olvido. La flota demo ya no necesita un PIN global. Si Fly conserva el
secreto antiguo, quítalo; luego despliega, despierta la máquina y deja
provisionadas las cuentas de panel de la demo:

```bash
fly secrets unset PIN
fly deploy
fly scale count 1 --yes && fly machine start
fly ssh console   # y dentro: node scripts/crear-admin-empresa.mjs <companyId> <username> -
```

La flota firma sus JWT dentro del backend y no necesita un PIN global. Si
`PIN` seguía configurado como secreto en Fly, `fly secrets unset PIN` lo quita.

La máquina va siempre prendida (`auto_stop_machines = "off"`,
`min_machines_running = 1`; dueño, 2026-11-02, unos 3,5 USD al mes): con la
máquina parada no hay buses simulados rodando y el respaldo enseñaría un mapa
vacío. Si se vuelve a dejar que duerma (`"stop"` y `0`), la despierta la
primera petición con un arranque en frío de unos segundos (por eso las apps
esperan 20 s al respaldo), y antes de presentar hay que despertarla a mano.

## Que el Mac se levante solo

Antes el backend y el túnel vivían de dos terminales abiertas: si el Mac se
reiniciaba de madrugada —una actualización, un corte de luz—, la demo
amanecía caída y nadie se enteraba hasta que alguien abría la app. Hoy los
cuatro servicios están cargados en este Mac y `check-demo.sh` lo confirma.

`scripts/servicio/` trae cuatro servicios de launchd para eso: el backend, el
túnel, la rotación de logs y el respaldo por hora. Se instalan una vez:

```bash
bash scripts/servicio/instalar-servicios.sh
```

Eso escribe los cuatro `.plist` en `~/Library/LaunchAgents` con las rutas de este
Mac resueltas, pero **no los activa**: activarlos mientras hay un backend a
mano deja dos procesos peleando por el puerto 3000 y por el mismo dominio de
ngrok. Se activan con el sistema en reposo, apagando antes lo que esté a mano:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yaviene.backend.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yaviene.ngrok.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yaviene.rotar-logs.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yaviene.respaldo.plist
```

`launchctl print gui/$UID/com.yaviene.backend` dice cómo va uno y
`launchctl bootout gui/$UID/com.yaviene.backend` lo para. Van por separado a
propósito: se caen por motivos distintos —el backend por un error del
programa, el túnel porque se fue el wifi— y así uno se reinicia sin arrastrar
al otro. Los dos vuelven solos, con 30 s entre intentos.

Los servicios no compilan nada: si `dist/` no existe, el backend no arranca y
lo dice en el log. Después de cambiar código sigue siendo `npm run build` y
`launchctl kickstart -k gui/$UID/com.yaviene.backend`.

Los logs pasan a `~/Library/Logs/YaViene/` (`backend.log`, `ngrok.log`,
`respaldo.log`), que es
una ruta fija que launchd puede abrir en cada arranque, y ya no a `/tmp`. Se
rotan de madrugada cuando pasan de 10 MB, guardando cinco generaciones; la
rotación copia y vacía el archivo en vez de renombrarlo, porque el proceso
escribe por un descriptor ya abierto y seguiría escribiendo en el archivo
viejo.

Lo que launchd no arregla, y toca a mano antes de un pitch:

- **Corriente**: el Mac enchufado. Con batería, macOS duerme el disco y la red
  aunque el proceso siga vivo.
- **Que no se duerma**: `sudo pmset -a sleep 0 disksleep 0` mientras dure el
  piloto, o dejar un `caffeinate -d -i -s` corriendo. Hoy el Mac tiene `sleep 1`
  y solo lo salva un `caffeinate` lanzado a mano.
- **Red de respaldo**: el punto de acceso del teléfono, probado antes y no el
  día de la demo. El dominio de ngrok no cambia al cambiar de red, así que no
  hay que recompilar nada; el túnel se reconecta solo.

## Lo que este runbook todavía no puede prometer

- Vigilancia externa que avise al teléfono del dueño cuando `/api/ready` deje
  de responder (T10.2): el chequeo real es `/api/ready`, no `/api/health` —
  `health` solo confirma que el proceso vive, así que con `health` una base
  caída pasaría desapercibida. Hoy, si nadie mira, nadie se entera.
- Los ajustes de energía y la prueba del punto de acceso siguen siendo
  manuales (T10.3): `check-demo.sh` avisa si el Mac va con batería o se puede
  dormir, pero no lo arregla.
- Alta y revocación de dispositivos GPS (T4.3).
