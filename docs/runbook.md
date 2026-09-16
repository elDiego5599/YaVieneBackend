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
sigue sirviendo. No usar `start-test.sh`, que levanta cloudflared con una URL
distinta cada vez y obliga a recompilar y repartir de nuevo.

## Arrancar

```bash
cd /Users/diegoangarita/YaViene/YaVieneBackend
npm run build
set -a && source local.env && set +a
nohup node dist/index.js </dev/null > /tmp/yaviene-backend.log 2>&1 &
```

`local.env` trae `JWT_SECRET` y `ADMIN_API_KEY`; si falta el primero, o tiene
menos de 32 caracteres, el arranque se detiene con un mensaje `[Config]`. Para
desarrollo, con recarga en caliente, `make dev` hace lo mismo cargando el mismo
archivo.

**Después de tocar el código del backend hay que volver a `npm run build`
antes de reiniciar**: `node dist/index.js` corre lo compilado, y más de una vez
un `dist` viejo hizo parecer que una migración nueva fallaba.

El túnel, en otra terminal:

```bash
ngrok start yaviene --log=stdout
```

Los buses de la demo no se arrancan a mano: el propio backend levanta doce
simuladores al iniciar (`src/demo/flota_demo.ts`). Para apagarlos —tráfico real,
donde esas posiciones falsas viajarían por el mismo canal que las buenas—
`YA_VIENE_FLOTA_DEMO=0` delante del arranque.

## Saber que está sano

```bash
curl -s https://occupy-shed-squatter.ngrok-free.dev/api/health   # {"status":"ok","uptime":…}
curl -s https://occupy-shed-squatter.ngrok-free.dev/api/ready    # {"status":"ready"}
```

`/api/health` solo dice que el proceso vive. `/api/ready` responde 503 con
`DATABASE_NOT_READY` si la base no contesta y con `BROKER_NOT_READY` si el
broker MQTT no está listo; es el que hay que mirar cuando algo va raro.

La revisión completa, antes de cualquier demo:

```bash
cd /Users/diegoangarita/YaViene/YaViene && bash check-demo.sh
```

En unos veinte segundos comprueba el túnel, que los buses publiquen por el
socket (lo mismo que ve la app) y que la base esté recibiendo posiciones
frescas. Sale con código 1 si algo falla. Lo que no automatiza: abrir el panel
y ver «En línea», y abrir el pasajero y ver los buses moverse.

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

Hacer una copia (con el backend encendido; usa el respaldo en línea de SQLite,
así que no hace falta parar nada):

```bash
cd /Users/diegoangarita/YaViene/YaVieneBackend
bash scripts/make-backup.sh
```

Guarda en `~/Desktop/YaViene_Backups/`, conserva las diez últimas y verifica
cada copia con `PRAGMA integrity_check`. A un destino concreto:

```bash
npm run backup -- /ruta/destino.db
```

Restaurar, paso a paso:

```bash
# 1. Parar el backend.
kill "$(lsof -ti :3000)"

# 2. Apartar la base actual, con sus archivos de WAL.
cd /Users/diegoangarita/YaViene/YaVieneBackend/data
mv yaviene.db yaviene.db.roto; rm -f yaviene.db-wal yaviene.db-shm

# 3. Poner la copia en su lugar y comprobarla antes de arrancar.
cp ~/Desktop/YaViene_Backups/yaviene-<fecha>.db yaviene.db
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

Lo que todavía no está resuelto (tarea T2.8 del plan): las copias son manuales y
viven en el mismo Mac que la base, así que una copia a iCloud o a una USB es
parte del trabajo. Falta automatizarlas por hora con retención, y falta
comprobar qué retención tienen los snapshots del volumen de Fly.

## Quitarle el panel a alguien

Cambiar la contraseña sube la versión de la credencial, y eso invalida los
tokens ya emitidos:

```bash
node scripts/crear-admin-empresa.mjs <companyId> <username> <password> [nombre]
```

La contraseña ha de tener 12 caracteres o más. El backend revisa los paneles
conectados cada minuto, así que una sesión abierta se cae sola en menos de 60 s
y el panel muestra «Tu sesión expiró». Si en ese momento la base no responde,
la revisión deja pasar al panel y lo saca en la primera vuelta en que la base
conteste; el tope sigue siendo la caducidad del token, ocho horas.

Borrar la cuenta entera:

```bash
node scripts/borrar-admin-empresa.mjs <username>
```

Avisa y no borra si es la única cuenta de esa empresa, porque dejaría el panel
de esa empresa sin forma de entrar. **Borrar no revoca**: el token que esa
persona ya tiene sigue valiendo hasta ocho horas. Si hay prisa, primero cambiar
la contraseña (que sí revoca) y después borrar.

Las contraseñas se teclean en el momento: no van en este documento, ni en un
script, ni en la CI.

## Sacar un bus del mapa

Desde el panel de la empresa: ocultar un bus, ocultar toda la flota o borrar el
bus. El equipo del bus puede cerrar su turno con
`POST /api/buses/:busId/offline`, que además revoca su sesión.

Dar de alta y revocar dispositivos con credencial propia —un secreto por
equipo, revocable sin tocar el resto— todavía no existe; es la tarea T4.3.

## Qué ve la gente en cada caso

| Situación | Pasajero | Panel |
|-----------|----------|-------|
| Todo bien | Buses moviéndose | «En línea» |
| Túnel caído, respaldo en pie | Buses del respaldo en ~41 s y la línea «Conectado al respaldo» | Igual, con la línea en la cabecera |
| Túnel y respaldo caídos | Sigue reintentando, sin buses nuevos; el mapa y el último estado se quedan | Sin flota; «Recargar» no arregla nada hasta que vuelva |
| Backend reiniciado | Se resuscribe solo y vuelven los buses | Vuelve a pedir la flota solo |
| Bus sin señal (5 min sin publicar) | «Bus sin señal» en la hoja, y el aviso de cercanía queda bloqueado | El bus deja de actualizarse |
| Panel revocado | — | «Tu sesión expiró» en menos de 60 s |

## Fly, el respaldo

No se despliega hasta el día anterior a presentar: es una decisión del dueño, no
un olvido. Cuando toque, lo mínimo es desplegar, despertar la máquina y dejar
provisionadas las cuentas de panel de la demo:

```bash
fly deploy
fly scale count 1 --yes && fly machine start
fly ssh console   # y dentro: node scripts/crear-admin-empresa.mjs …
```

La máquina duerme sola (`auto_stop_machines`) y la despierta la primera
petición, con un arranque en frío de unos segundos —por eso las apps esperan
20 s al respaldo—. Para el día de la presentación conviene
dejarla despierta antes de empezar: con la máquina parada no hay buses
simulados rodando y el respaldo enseñaría un mapa vacío.

## Lo que este runbook todavía no puede prometer

- Copias automáticas y restauración cronometrada (T2.8).
- Vigilancia externa que avise al teléfono del dueño cuando `/api/health` deje
  de responder (T10.2): hoy, si nadie mira, nadie se entera.
- Arranque automático del backend y del túnel al encender el Mac, y que el Mac
  no se duerma (T10.3).
- Alta y revocación de dispositivos GPS (T4.3).
