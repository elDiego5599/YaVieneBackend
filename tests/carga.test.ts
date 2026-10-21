// La herramienta de carga (scripts/carga.ts) sirve y no deja rastro.
//
// Corre la herramienta de verdad con pocos buses y pocos segundos: todos se
// conectan, el backend acepta cada posición, cada una llega a los pasajeros,
// el informe trae latencias, CPU y memoria, y la base temporal ya no existe
// al terminar.
//
// Puertos propios, HTTP 3220 y MQTT 9000: node --test corre los archivos en
// paralelo (el reparto de los demás está en arranque.test.ts).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { percentil, percentilHistograma } from '../scripts/histograma';

test('percentilHistograma calcula percentiles desde casillas de un milisegundo', () => {
  const histograma = new Map([[3, 2], [1, 1], [2, 1]]);
  const ordenadas = [1, 2, 3, 3];
  assert.equal(percentilHistograma(histograma, 4, 0), 1);
  assert.equal(percentilHistograma(histograma, 4, 0.5), 3);
  assert.equal(percentilHistograma(histograma, 4, 0.99), 3);
  for (const p of [0.5, 0.95, 0.99]) {
    assert.equal(percentilHistograma(histograma, ordenadas.length, p), percentil(ordenadas, p));
  }
  assert.equal(percentilHistograma(new Map(), 0, 0.5), null);
});

test('la herramienta falla rápido y nombra un puerto HTTP ocupado', { timeout: 15_000 }, async () => {
  const servidor = createServer();
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const direccion = servidor.address();
  assert.ok(direccion && typeof direccion !== 'string');
  const puerto = direccion.port;
  const inicio = Date.now();
  try {
    const hijo = spawn(process.execPath, [
      '--import', 'tsx', 'scripts/carga.ts',
      '--http-port', String(puerto), '--mqtt-port', '9000',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    hijo.stdout.on('data', (d) => (salida += d));
    hijo.stderr.on('data', (d) => (salida += d));
    const codigo = await new Promise<number | null>((resolve) => hijo.once('exit', resolve));
    assert.notEqual(codigo, 0, salida);
    assert.match(salida, new RegExp(`puerto ${puerto} .*ocupado`));
    assert.ok(Date.now() - inicio < 5000, `tardó ${Date.now() - inicio} ms`);
  } finally {
    await new Promise<void>((resolve, reject) => servidor.close((error) => error ? reject(error) : resolve()));
  }
});

test('la herramienta de carga mide una corrida corta y borra su base', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaviene-carga-test-'));
  const informe = join(dir, 'informe.json');
  try {
    const hijo = spawn(process.execPath, [
      '--import', 'tsx', 'scripts/carga.ts',
      '--buses', '6', '--segundos', '3', '--cadencia-ms', '1000',
      '--pasajeros', '12',
      '--http-port', '3220', '--mqtt-port', '9000', '--informe', informe,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    hijo.stdout.on('data', (d) => (salida += d));
    hijo.stderr.on('data', (d) => (salida += d));
    const codigo = await new Promise<number | null>((resolve) => hijo.once('exit', resolve));
    assert.equal(codigo, 0, salida);

    const r = JSON.parse(readFileSync(informe, 'utf8'));
    assert.equal(r.buses, 6);
    assert.equal(r.conectados, 6);
    assert.equal(r.rutas, 6);
    assert.equal(r.pasajeros.solicitados, 12);
    assert.equal(r.pasajeros.conectados, 12);
    assert.deepEqual(Object.values(r.pasajeros.rutas), [2, 2, 2, 2, 2, 2]);
    assert.ok(r.publicadas >= 12, `publicadas: ${r.publicadas}`);
    assert.deepEqual(r.acks, { aceptada: r.publicadas });
    assert.equal(r.pasajeros.posicionesRecibidas, r.publicadas * 2);
    assert.equal(typeof r.pasajeros.latenciaMs.p95, 'number');
    assert.equal(r.pasajeros.limitePorIp.maximo, 100);
    assert.ok(r.pasajeros.posicionesPorSocket.minimo >= 2);
    assert.equal(typeof r.pasajeros.posicionesPorSocket.mediana, 'number');
    assert.equal(r.pasajeros.limitePorIp.rechazados, 0);
    assert.deepEqual(r.pasajeros.fallidosConexion, {});
    assert.equal(typeof r.backend.cpuPromedioPct, 'number');
    assert.ok(r.backend.rssMaxMb > 0);

    // La base era temporal y se fue con la corrida.
    const db = /SQLite abierta en (\S+)/.exec(salida)?.[1];
    assert.ok(db?.startsWith(tmpdir()) || db?.startsWith('/private' + tmpdir()), `base: ${db}`);
    assert.equal(existsSync(dirname(db!)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
