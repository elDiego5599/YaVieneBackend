// La herramienta de carga (scripts/carga.ts) sirve y no deja rastro.
//
// Corre la herramienta de verdad con pocos buses y pocos segundos: todos se
// conectan, el backend acepta cada posición, cada una llega a un pasajero,
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
import test from 'node:test';

test('la herramienta de carga mide una corrida corta y borra su base', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaviene-carga-test-'));
  const informe = join(dir, 'informe.json');
  try {
    const hijo = spawn(process.execPath, [
      '--import', 'tsx', 'scripts/carga.ts',
      '--buses', '6', '--segundos', '3', '--cadencia-ms', '1000',
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
    assert.ok(r.publicadas >= 12, `publicadas: ${r.publicadas}`);
    assert.deepEqual(r.acks, { aceptada: r.publicadas });
    assert.equal(r.pasajeros.posicionesRecibidas, r.publicadas);
    assert.equal(typeof r.pasajeros.latenciaMs.p95, 'number');
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
