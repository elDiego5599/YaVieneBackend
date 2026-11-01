// AUD29-16 y AUD29-11: el log no se llena con cada pasajero que abre la app
// y lo que manda un cliente no entra crudo en él.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { io as conectar, Socket } from 'socket.io-client';

process.env.YA_VIENE_DB_PATH = join(mkdtempSync(join(tmpdir(), 'yaviene-logs-')), 'logs.db');
process.env.JWT_SECRET = 'test-jwt-secret';
delete process.env.SOCKET_DEBUG_LOGS;

const { textoParaLog, MAX_TEXTO_LOG } = require('../src/observability/texto_log') as typeof import('../src/observability/texto_log');
const { setupSocketServer, closeSocketServer } = require('../src/socket/handler') as typeof import('../src/socket/handler');
const { getMetrics } = require('../src/observability/metrics') as typeof import('../src/observability/metrics');

const esperar = (ms: number): Promise<void> => new Promise((listo) => setTimeout(listo, ms));

async function hasta(condicion: () => boolean, ms: number): Promise<boolean> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (condicion()) return true;
    await esperar(20);
  }
  return condicion();
}

const contador = (nombre: string): number => getMetrics().counters[nombre] ?? 0;

test('conectar y desconectar sockets cuenta en métricas y no escribe en el log', async () => {
  const servidor = createServer();
  setupSocketServer(servidor);
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const dir = servidor.address();
  const puerto = typeof dir === 'object' && dir ? dir.port : 0;

  const log = mock.method(console, 'log', () => {});
  const antesConexiones = contador('socket.conexiones');
  const antesDesconexiones = contador('socket.desconexiones');
  const clientes: Socket[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const c = conectar(`http://127.0.0.1:${puerto}`, {
        path: '/ws',
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      clientes.push(c);
      await new Promise<void>((listo) => c.once('connect', () => listo()));
    }
    assert.ok(await hasta(() => contador('socket.conexiones') - antesConexiones === 3, 2000));
    for (const c of clientes) c.disconnect();
    assert.ok(await hasta(() => contador('socket.desconexiones') - antesDesconexiones === 3, 2000));

    const delSocket = log.mock.calls.filter((c) => String(c.arguments[0]).startsWith('[WS]'));
    assert.deepEqual(delSocket, []);
  } finally {
    log.mock.restore();
    for (const c of clientes) c.close();
    closeSocketServer();
    await new Promise<void>((listo) => servidor.close(() => listo()));
  }
});

test('textoParaLog quita los saltos y lo que no se imprime, y corta lo largo', () => {
  assert.equal(textoParaLog('empresa/EMP-01/bus/B1/posicion'), '"empresa/EMP-01/bus/B1/posicion"');
  // Un salto de línea en el topic fingiría una línea de log nueva.
  assert.equal(textoParaLog('a\n[MQTT] Auth OK\r\u0000b'), '"a\\n[MQTT] Auth OK\\r\\u0000b"');
  assert.equal(textoParaLog('\u202Eoculto'), '"\\u202eoculto"');
  const largo = textoParaLog('x'.repeat(5000));
  assert.equal(largo, `"${'x'.repeat(MAX_TEXTO_LOG)}…" (5000 caracteres)`);
});

test('ningún topic ni evento de un cliente va crudo al log', () => {
  const fuentes = ['src/mqtt/broker.ts', 'src/index.ts', 'src/socket/handler.ts'].map((archivo) => [
    archivo,
    readFileSync(join(__dirname, '..', archivo), 'utf8'),
  ]);
  for (const [archivo, codigo] of fuentes) {
    for (const linea of codigo.split('\n').filter((l) => /console\.(log|warn|error)/.test(l))) {
      assert.doesNotMatch(linea, /\$\{(topic|packet\.topic|event)\}/, `${archivo}: ${linea.trim()}`);
    }
  }
});
