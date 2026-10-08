import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import test from 'node:test';

import Database from 'better-sqlite3';
import { io } from 'socket.io-client';

import { flotaDemoHabilitada, hostHttp, validateConfig } from '../src/config';
import { aceptaRemotos } from '../src/security/red_local';
import { HOST_PRUEBAS, hayIpv6 } from './red_pruebas';

const JWT_LARGO = 'j'.repeat(64);
const CLAVE_LARGA = 'k'.repeat(48);

test('validateConfig: el arranque local de siempre (local.env) no da errores', () => {
  // local.env define PIN: la flota demo viene encendida en desarrollo y
  // validateConfig no la deja arrancar sin él.
  const { errores, avisos } = validateConfig({ JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, PIN: '1234' });
  assert.deepEqual(errores, []);
  assert.deepEqual(avisos, []);
});

test('validateConfig: el arranque de Fly (producción, sin CORS, MQTT en loopback) no da errores', () => {
  const { errores, avisos } = validateConfig({
    NODE_ENV: 'production',
    JWT_SECRET: JWT_LARGO,
    ADMIN_API_KEY: CLAVE_LARGA,
    YA_VIENE_DB_PATH: '/data/yaviene.db',
    // fly.toml lo declara: el TLS lo termina el proxy de Fly.
    HTTP_TLS_EXTERNO: '1',
  });
  assert.deepEqual(errores, []);
  assert.deepEqual(avisos, []);
});

test('validateConfig: secretos ausentes o en blanco', () => {
  // Dos errores: JWT_SECRET ausente y la flota demo (encendida por defecto
  // en desarrollo) sin PIN.
  assert.equal(validateConfig({}).errores.length, 2);
  assert.match(validateConfig({ JWT_SECRET: '   ' }).errores[0], /JWT_SECRET/);
  assert.match(validateConfig({ JWT_SECRET: 'x', ADMIN_API_KEY: '  ' }).errores[0], /ADMIN_API_KEY/);
  assert.match(
    validateConfig({ NODE_ENV: 'production', JWT_SECRET: JWT_LARGO }).errores[0],
    /ADMIN_API_KEY es obligatoria/,
  );
  // La clave de admin corta en producción avisa; el JWT corto ya no (abajo).
  const cortos = validateConfig({
    NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: 'corta', HTTP_TLS_EXTERNO: '1',
  });
  assert.deepEqual(cortos.errores, []);
  assert.equal(cortos.avisos.length, 1);
});

// Con un JWT_SECRET corto cualquiera que vea un token puede probar secretos
// por fuerza bruta sin conexión y firmarse uno de admin. Avisar no bastaba:
// el aviso se pierde en el log y el servidor sigue firmando con él.
test('validateConfig: JWT_SECRET de menos de 32 caracteres no arranca en producción', () => {
  const prod = { NODE_ENV: 'production', ADMIN_API_KEY: CLAVE_LARGA, HTTP_TLS_EXTERNO: '1' };
  assert.match(validateConfig({ ...prod, JWT_SECRET: 'j'.repeat(31) }).errores[0], /JWT_SECRET/);
  assert.deepEqual(validateConfig({ ...prod, JWT_SECRET: 'j'.repeat(32) }).errores, []);
  // Fuera de producción (ngrok, tests) sigue valiendo uno corto. El PIN es
  // el de la flota demo, que en desarrollo viene encendida.
  assert.deepEqual(validateConfig({ JWT_SECRET: 'corto', PIN: '1234' }).errores, []);
});

// La flota simulada publica en el mismo canal que los buses reales: en
// producción se enciende solo si el despliegue lo escribe.
// P2-4: el backend que da la cara a internet es el del Mac detrás de
// ngrok, y no es «producción» (eso abriría la red local y apagaría la flota
// demo). YA_VIENE_EXPUESTO=1 le pone las guardias de secretos y de CORS sin
// tocar lo demás.
test('validateConfig: YA_VIENE_EXPUESTO=1 exige los secretos de producción y nada más', () => {
  const base = { YA_VIENE_EXPUESTO: '1', PIN: '1234' };
  assert.deepEqual(validateConfig({ ...base, JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA }).errores, []);
  assert.match(
    validateConfig({ ...base, JWT_SECRET: 'j'.repeat(31), ADMIN_API_KEY: CLAVE_LARGA }).errores.join(),
    /JWT_SECRET tiene menos de 32/,
  );
  assert.match(validateConfig({ ...base, JWT_SECRET: JWT_LARGO }).errores.join(), /ADMIN_API_KEY es obligatoria/);
  assert.equal(validateConfig({ ...base, JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: 'corta' }).avisos.length, 1);
  assert.match(
    validateConfig({ ...base, JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, CORS_ORIGINS: 'http://sitio.co' })
      .errores.join(),
    /no es https/,
  );
  // Lo que es solo de Fly no cambia: ni TLS propio, ni flota, ni red.
  const env = { ...base, JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA };
  assert.equal(flotaDemoHabilitada(env), true);
  assert.equal(aceptaRemotos(env), false);
});

test('flotaDemoHabilitada: apagada en producción salvo que se pida', () => {
  assert.equal(flotaDemoHabilitada({ NODE_ENV: 'production' }), false);
  assert.equal(flotaDemoHabilitada({ NODE_ENV: 'production', YA_VIENE_FLOTA_DEMO: '1' }), true);
  assert.equal(flotaDemoHabilitada({}), true, 'en desarrollo (ngrok) la demo sigue por defecto');
  assert.equal(flotaDemoHabilitada({ YA_VIENE_FLOTA_DEMO: '0' }), false);
});

// Los buses simulados registran conductores con un PIN y luego inician
// sesión con él; el script traía «1234» por omisión. Con la flota encendida
// el PIN tiene que venir del entorno (local.env, fly.toml).
test('validateConfig: la flota demo encendida exige PIN en el entorno', () => {
  const local = { JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA };
  assert.match(validateConfig({ ...local, YA_VIENE_FLOTA_DEMO: '1' }).errores[0], /PIN/);
  assert.match(validateConfig(local).errores[0], /PIN/, 'en desarrollo la demo viene encendida por defecto');
  assert.deepEqual(validateConfig({ ...local, PIN: '1234' }).errores, []);
  assert.deepEqual(
    validateConfig({ ...local, YA_VIENE_FLOTA_DEMO: '0' }).errores,
    [],
    'con la flota apagada no hace falta PIN',
  );
});

test('validateConfig: flota demo encendida en producción deja aviso', () => {
  const prod = {
    NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, HTTP_TLS_EXTERNO: '1',
  };
  // Con la siembra también encendida (como en fly.toml): sin ella el arranque
  // suma el aviso de «flota demo sin siembra», que prueba `siembra.test.ts`.
  const encendida = validateConfig({ ...prod, YA_VIENE_FLOTA_DEMO: '1', YA_VIENE_SEED_DEMO: '1', PIN: '1234' });
  assert.deepEqual(encendida.errores, []);
  assert.equal(encendida.avisos.length, 1);
  assert.match(encendida.avisos[0], /flota demo ENCENDIDA en producción/);
  assert.deepEqual(validateConfig(prod).avisos, []);
  assert.deepEqual(validateConfig({ JWT_SECRET: JWT_LARGO, YA_VIENE_FLOTA_DEMO: '1' }).avisos, []);
});

test('validateConfig: TLS a medias no arranca en claro sin avisar', () => {
  assert.match(
    validateConfig({ JWT_SECRET: 'x', HTTP_TLS_CERT_PATH: '/c.pem' }).errores[0],
    /HTTP_TLS_CERT_PATH y HTTP_TLS_KEY_PATH/,
  );
  assert.match(
    validateConfig({ JWT_SECRET: 'x', MQTT_TLS_KEY_PATH: '/k.pem' }).errores[0],
    /MQTT_TLS_CERT_PATH y MQTT_TLS_KEY_PATH/,
  );
  assert.deepEqual(
    validateConfig({ JWT_SECRET: 'x', HTTP_TLS_CERT_PATH: '/c.pem', HTTP_TLS_KEY_PATH: '/k.pem', PIN: '1234' }).errores,
    [],
  );
});

test('validateConfig: MQTT por TCP fuera de loopback exige TLS en producción', () => {
  const dev = validateConfig({ JWT_SECRET: 'x', MQTT_HOST: '0.0.0.0', PIN: '1234' });
  assert.deepEqual(dev.errores, []);
  assert.equal(dev.avisos.length, 1);
  const prod = {
    NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, HTTP_TLS_EXTERNO: '1', MQTT_HOST: '0.0.0.0',
  };
  assert.match(validateConfig(prod).errores[0], /MQTT_HOST/);
  assert.deepEqual(
    validateConfig({ ...prod, MQTT_TLS_CERT_PATH: '/c.pem', MQTT_TLS_KEY_PATH: '/k.pem' }).errores,
    [],
  );
});

test('validateConfig: CORS solo con orígenes exactos, y https en producción', () => {
  assert.deepEqual(validateConfig({ JWT_SECRET: 'x', CORS_ORIGINS: 'http://localhost:8091', PIN: '1234' }).errores, []);
  assert.equal(validateConfig({ JWT_SECRET: 'x', CORS_ORIGINS: '*', PIN: '1234' }).errores.length, 1);
  assert.equal(
    validateConfig({ JWT_SECRET: 'x', CORS_ORIGINS: 'https://yaviene.co/', PIN: '1234' }).errores.length,
    1,
    'con barra final no coincide nunca con la cabecera Origin',
  );
  const prod = { NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, HTTP_TLS_EXTERNO: '1' };
  assert.deepEqual(validateConfig({ ...prod, CORS_ORIGINS: 'https://yaviene.co, https://www.yaviene.co' }).errores, []);
  assert.match(validateConfig({ ...prod, CORS_ORIGINS: 'http://yaviene.co' }).errores[0], /https/);
});

// Por el HTTP pasan la contraseña del panel y el PIN del conductor. En
// producción arrancaba en claro sin avisar; ahora hace falta el par TLS o
// declarar que lo termina un proxy delante.
test('validateConfig: en producción el HTTP no arranca en claro sin decirlo', () => {
  const prod = { NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA };
  assert.match(validateConfig(prod).errores[0], /HTTP_TLS_EXTERNO/);
  assert.equal(validateConfig({ ...prod, HTTP_TLS_EXTERNO: 'true' }).errores.length, 1, 'solo vale «1»');
  assert.deepEqual(validateConfig({ ...prod, HTTP_TLS_EXTERNO: '1' }).errores, []);
  assert.deepEqual(
    validateConfig({ ...prod, HTTP_TLS_CERT_PATH: '/c.pem', HTTP_TLS_KEY_PATH: '/k.pem' }).errores,
    [],
  );
  // El arranque local con ngrok no es producción: sigue sin pedir nada.
  assert.deepEqual(validateConfig({ JWT_SECRET: JWT_LARGO, PIN: '1234' }).errores, []);
});

test('validateConfig: puertos que no son puertos', () => {
  assert.match(validateConfig({ JWT_SECRET: 'x', HTTP_PORT: 'abc' }).errores[0], /HTTP_PORT/);
  assert.match(validateConfig({ JWT_SECRET: 'x', MQTT_PORT: '70000' }).errores[0], /MQTT_PORT/);
});

// HTTP_HOST existe para las máquinas sin IPv6 (el contenedor de la nube);
// sin la variable, o vacía, todo sigue en '::'.
test('hostHttp: sin HTTP_HOST, o vacía, es ::; con ella, la que diga', () => {
  assert.equal(hostHttp({}), '::');
  assert.equal(hostHttp({ HTTP_HOST: '' }), '::');
  assert.equal(hostHttp({ HTTP_HOST: '127.0.0.1' }), '127.0.0.1');
});

test('validateConfig: HTTP_HOST solo acepta una IP, y en producción no una de loopback', () => {
  const local = { JWT_SECRET: 'x', PIN: '1234' };
  assert.deepEqual(validateConfig({ ...local, HTTP_HOST: '127.0.0.1' }).errores, []);
  assert.deepEqual(validateConfig({ ...local, HTTP_HOST: '0.0.0.0' }).errores, []);
  assert.match(validateConfig({ ...local, HTTP_HOST: 'localhost' }).errores[0], /HTTP_HOST/);
  assert.match(validateConfig({ ...local, HTTP_HOST: '127.0.0.1 ' }).errores[0], /HTTP_HOST/);
  const prod = { NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, HTTP_TLS_EXTERNO: '1' };
  assert.deepEqual(validateConfig(prod).errores, []);
  assert.deepEqual(validateConfig({ ...prod, HTTP_HOST: '0.0.0.0' }).errores, []);
  assert.match(validateConfig({ ...prod, HTTP_HOST: '127.0.0.1' }).errores[0], /HTTP_HOST/);
  assert.match(validateConfig({ ...prod, HTTP_HOST: '::1' }).errores[0], /HTTP_HOST/);
});

// ── Arranque real ─────────────────────────────────────────────────────
// Entorno mínimo a propósito: nada heredado del de quien corre los tests,
// así se ve qué necesita el backend para arrancar y qué lo detiene.
//
// Puertos propios: HTTP 3150-3159, MQTT 8920-8929. node --test corre los
// archivos en paralelo; si dos comparten puerto, uno no arranca y sus pruebas
// le hablan al backend del otro. Reparto: e2e 312x, chaos 313x, fleet 314x,
// arranque 315x, socket_abuso 316x, evento_prohibido 317x, cors 318x,
// respaldo 319x, cerrar_sesion 320x, sockets_por_ip 321x, contrato 323x,
// tipologia 324x, socket_falla_base 325x, mqtt_abuso 326x,
// seguridad_p2 327x, limpieza_p3 328x, panel_cookie 329x, panel_web 330x.
function arrancar(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      YA_VIENE_FLOTA_DEMO: '0',
      MQTT_DEBUG_LOGS: 'false',
      // El entorno limpio no hereda el HTTP_HOST de tests/entorno.ts.
      HTTP_HOST: HOST_PRUEBAS,
      ...env,
    },
    // El cuarto canal es IPC: en Windows el apagado graceful va por mensaje
    // ('shutdown') porque kill() no entrega señales; en POSIX no se usa.
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}

function esperarSalida(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`El proceso no terminó en ${timeoutMs} ms. stderr:\n${stderr}`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function borrarBase(dbPath: string): void {
  for (const sufijo of ['', '-wal', '-shm']) rmSync(`${dbPath}${sufijo}`, { force: true });
}

test('arranque: una configuración insegura no llega a levantar el servidor', { timeout: 60_000 }, async () => {
  const dbPath = `/tmp/yaviene-arranque-rechazo-${process.pid}.db`;
  const comunes = { HTTP_PORT: '3153', MQTT_PORT: '8923', YA_VIENE_DB_PATH: dbPath };
  const casos: Record<string, string>[] = [
    { JWT_SECRET: '   ' },
    { JWT_SECRET: JWT_LARGO, HTTP_TLS_CERT_PATH: '/no/existe/cert.pem' },
    { JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, NODE_ENV: 'production', CORS_ORIGINS: '*' },
  ];
  try {
    for (const caso of casos) {
      const { code, stderr } = await esperarSalida(arrancar({ ...comunes, ...caso }), 20_000);
      assert.notEqual(code, 0, `debió negarse a arrancar con ${JSON.stringify(caso)}`);
      assert.match(stderr, /\[Config\]/, 'el motivo sale en el registro');
    }
  } finally {
    borrarBase(dbPath);
  }
});

// SQLite abre sin quejarse un archivo con la cabecera sana y páginas rotas:
// el daño salía después, en la primera consulta que tocara esa página, con
// el servidor ya aceptando buses. Mejor no arrancar y decir qué hacer.
test('arranque: una base con páginas corruptas no arranca y el mensaje nombra el backup', { timeout: 60_000 }, async () => {
  const dbPath = `/tmp/yaviene-arranque-corrupta-${process.pid}.db`;
  borrarBase(dbPath);
  const sana = new Database(dbPath);
  sana.exec('CREATE TABLE relleno (id INTEGER PRIMARY KEY, texto TEXT)');
  const insertar = sana.prepare('INSERT INTO relleno (texto) VALUES (?)');
  for (let i = 0; i < 200; i++) insertar.run('x'.repeat(200));
  sana.close();
  // Página 2 = bytes 4096-8191 con el tamaño de página por defecto (4096).
  // La página 1 lleva la cabecera y queda intacta.
  const fd = openSync(dbPath, 'r+');
  writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, 4096);
  closeSync(fd);
  try {
    const { code, stderr } = await esperarSalida(arrancar({
      JWT_SECRET: JWT_LARGO, HTTP_PORT: '3154', MQTT_PORT: '8924', YA_VIENE_DB_PATH: dbPath,
    }), 20_000);
    assert.notEqual(code, 0, 'con la base dañada no debe arrancar');
    assert.match(stderr, /dañada/);
    assert.match(stderr, /backup-db/, 'el mensaje dice con qué restaurar');
  } finally {
    borrarBase(dbPath);
  }
});

test('arranque: un archivo que no es una base también se da por dañado', { timeout: 60_000 }, async () => {
  const dbPath = `/tmp/yaviene-arranque-nobase-${process.pid}.db`;
  borrarBase(dbPath);
  // Ni la cabecera sirve: SQLite lanza SQLITE_NOTADB en vez de devolver texto.
  const fd = openSync(dbPath, 'w');
  writeSync(fd, Buffer.alloc(8192, 0xa5));
  closeSync(fd);
  try {
    const { code, stderr } = await esperarSalida(arrancar({
      JWT_SECRET: JWT_LARGO, HTTP_PORT: '3157', MQTT_PORT: '8927', YA_VIENE_DB_PATH: dbPath,
    }), 20_000);
    assert.notEqual(code, 0, 'con un archivo que no es base no debe arrancar');
    assert.match(stderr, /dañada/);
    assert.match(stderr, /backup-db/);
  } finally {
    borrarBase(dbPath);
  }
});

// Antes cualquier fallo de la revisión salía como «dañada, restaura el
// backup». Con la base sana y bloqueada por otro proceso, restaurar perdía
// lo escrito desde la última copia.
test('arranque: una base bloqueada por otro proceso no se da por dañada ni manda a restaurar', { timeout: 60_000 }, async () => {
  const dbPath = `/tmp/yaviene-arranque-bloqueada-${process.pid}.db`;
  borrarBase(dbPath);
  const bloqueo = new Database(dbPath);
  bloqueo.exec('CREATE TABLE relleno (id INTEGER PRIMARY KEY)');
  // En modo de diario por defecto, EXCLUSIVE no deja leer a nadie más: la
  // revisión espera los 5 s de better-sqlite3 y sale con SQLITE_BUSY.
  bloqueo.exec('BEGIN EXCLUSIVE');
  try {
    const { code, stderr } = await esperarSalida(arrancar({
      JWT_SECRET: JWT_LARGO, HTTP_PORT: '3155', MQTT_PORT: '8925', YA_VIENE_DB_PATH: dbPath,
    }), 30_000);
    assert.notEqual(code, 0, 'sin poder revisar la base no debe arrancar');
    assert.match(stderr, /No se pudo revisar la base/);
    assert.match(stderr, /SQLITE_BUSY/, 'el mensaje trae el código de SQLite');
    assert.doesNotMatch(stderr, /dañada/);
    assert.doesNotMatch(stderr, /backup-db/, 'no manda a restaurar una base que puede estar sana');
  } finally {
    bloqueo.exec('ROLLBACK');
    bloqueo.close();
    borrarBase(dbPath);
  }
});

test('arranque: humo con base temporal, y el apagado guarda métricas y sale limpio', { timeout: 60_000 }, async () => {
  const port = 3152;
  const dbPath = `/tmp/yaviene-arranque-humo-${process.pid}-${Date.now()}.db`;
  const backend = arrancar({
    JWT_SECRET: 'humo-jwt-secret',
    HTTP_PORT: String(port),
    MQTT_PORT: '8922',
    YA_VIENE_DB_PATH: dbPath,
  });
  const salida = esperarSalida(backend, 45_000);

  try {
    const deadline = Date.now() + 15_000;
    let listo = false;
    while (!listo && Date.now() < deadline) {
      try {
        listo = (await fetch(`http://127.0.0.1:${port}/api/ready`)).status === 200;
      } catch {}
      if (!listo) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(listo, '/api/ready debe responder 200');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

    // Algo que deje una métrica en memoria: un socket que se pasa del
    // presupuesto de eventos y al que el servidor echa.
    const socket = io(`http://127.0.0.1:${port}`, { path: '/ws', transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const echado = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    for (let i = 0; i < 40; i++) socket.emit('subscribe:route', 'R-101');
    await echado;
    socket.close();

    // Apagado graceful por la vía de cada OS, mismo `shutdown` y mismo
    // volcado: SIGTERM en POSIX, mensaje IPC en Windows (kill() no entrega
    // señales al hijo: termina sin correr handlers).
    const inicio = Date.now();
    if (process.platform === 'win32') {
      assert.ok(backend.send?.('shutdown'), 'el hijo debe tener canal IPC');
    } else {
      backend.kill('SIGTERM');
    }
    const { code, stderr } = await salida;
    assert.equal(code, 0, `el apagado ordenado sale con 0. stderr:\n${stderr}`);
    assert.ok(Date.now() - inicio < 10_000, 'el apagado no se cuelga');

    // Las métricas se vuelcan cada 30 s: sin el volcado al apagar, esta se
    // habría perdido.
    const db = new Database(dbPath);
    try {
      const fila = db.prepare("SELECT value FROM metrics WHERE name = 'socket.flood.kicked'").get() as
        | { value: number }
        | undefined;
      assert.ok(fila && fila.value >= 1, 'la métrica llegó a disco');
    } finally {
      db.close();
    }
  } finally {
    if (backend.exitCode === null) backend.kill('SIGKILL');
    borrarBase(dbPath);
  }
});

// Toda la suite levanta sus backends con HTTP_HOST=127.0.0.1 (tests/entorno.ts)
// para poder correr donde no hay IPv6. Esta prueba arranca con un entorno
// limpio, sin la variable, y comprueba que el backend de verdad sigue en '::':
// con IPv6 contesta por 127.0.0.1 y por ::1 y el registro dice [::]; sin IPv6
// el arranque se cae justo por intentar '::' (EAFNOSUPPORT sobre :::puerto),
// que es lo que haría el backend vivo en esa máquina.
test('arranque: sin HTTP_HOST escucha en :: (IPv4 e IPv6 a la vez)', { timeout: 60_000 }, async () => {
  const port = 3156;
  const dbPath = `/tmp/yaviene-arranque-doble-pila-${process.pid}-${Date.now()}.db`;
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      YA_VIENE_FLOTA_DEMO: '0',
      MQTT_DEBUG_LOGS: 'false',
      JWT_SECRET: JWT_LARGO,
      HTTP_PORT: String(port),
      MQTT_PORT: '8926',
      YA_VIENE_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  backend.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  const salida = esperarSalida(backend, 45_000);

  try {
    if (!(await hayIpv6())) {
      const { code, stderr } = await salida;
      assert.notEqual(code, 0, 'sin IPv6, escuchar en :: no puede salir bien');
      assert.match(stderr, new RegExp(`EAFNOSUPPORT.*:::${port}`), `debió intentar '::'. stderr:\n${stderr}`);
      return;
    }

    const estado = async (url: string): Promise<number> => {
      try {
        return (await fetch(url)).status;
      } catch {
        return 0;
      }
    };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && await estado(`http://127.0.0.1:${port}/api/ready`) !== 200) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await estado(`http://127.0.0.1:${port}/api/ready`), 200, 'contesta por IPv4');
    assert.equal(await estado(`http://[::1]:${port}/api/ready`), 200, 'contesta por IPv6');
    assert.match(stdout, new RegExp(`listening on http://\\[::\\]:${port} \\(IPv4\\+IPv6\\)`));

    if (process.platform === 'win32') {
      assert.ok(backend.send?.('shutdown'), 'el hijo debe tener canal IPC');
    } else {
      backend.kill('SIGTERM');
    }
    const { code, stderr } = await salida;
    assert.equal(code, 0, `el apagado ordenado sale con 0. stderr:\n${stderr}`);
  } finally {
    if (backend.exitCode === null) backend.kill('SIGKILL');
    borrarBase(dbPath);
  }
});
