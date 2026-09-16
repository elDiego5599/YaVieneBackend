import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, Server as HTTPServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BusPosition } from '../src/data/bus_types';

/*
  El apagado ordenado cerraba el servidor de sockets y daba el módulo por
  terminado, pero los relojes que monta `setupSocketServer` seguían vivos:
  la vigilancia del consumidor lento, la revisión de los paneles y uno por
  ruta con el lote de posiciones pendientes. Los dos primeros llevan
  `unref`, así que no asoman como handles del proceso y no se notaban; el
  del lote no lo lleva, y es el que quedaba en pie al terminar una prueba y
  despertaba 100 ms después contra un socket ya cerrado.

  La ruta de la base se lee al cargar el módulo (`data/database.ts`), así
  que se fija ANTES del primer import de cualquier cosa que llegue hasta
  ella: este fichero es el primero que carga el handler del socket de
  forma directa, y el handler arrastra `data/buses`.
*/
const carpeta = mkdtempSync(join(tmpdir(), 'yaviene-apagado-'));
process.env.YA_VIENE_DB_PATH = join(carpeta, 'apagado.db');
process.env.JWT_SECRET = 'test-jwt-secret';

type ModuloHandler = typeof import('../src/socket/handler');
let handler: ModuloHandler;

/** Relojes que sostienen el proceso. Los que llevan `unref` no salen aquí. */
const relojesDelProceso = (): number =>
  process.getActiveResourcesInfo().filter((recurso) => recurso === 'Timeout').length;

const escuchar = (servidor: HTTPServer): Promise<void> =>
  new Promise((listo) => servidor.listen(0, '127.0.0.1', () => listo()));

// `io.close()` cierra también el servidor HTTP al que está pegado, así que
// puede llegar aquí ya cerrado: misma guardia que usa el apagado de verdad.
const cerrar = (servidor: HTTPServer): Promise<void> =>
  new Promise((listo) => {
    if (!servidor.listening) {
      listo();
      return;
    }
    servidor.close(() => listo());
  });

const posicion = (routeId: string): BusPosition => ({
  busId: 'BUS-APAGADO',
  routeId,
  lat: 10.9878,
  lon: -74.7889,
  heading: null,
  speedKmh: 0,
  sentido: null,
  timestamp: new Date().toISOString(),
  capturedAt: Date.now(),
  receivedAt: Date.now(),
  sequence: 1,
  driverPhone: '',
  // Con empresa puesta no hace falta preguntarle a la base quién es el bus.
  companyId: 'EMPRESA-APAGADO',
  isGhost: false,
});

test('setup: carga el socket contra una base temporal', async () => {
  handler = await import('../src/socket/handler');
  assert.equal(typeof handler.closeSocketServer, 'function', 'el módulo tiene que exportar su apagado');
  assert.equal(typeof handler.activeTimerCount, 'function', 'y una forma de contar sus relojes');
});

test('apagar el socket no deja ni un reloj vivo', async () => {
  const servidor = createServer();
  await escuchar(servidor);
  try {
    assert.equal(handler.activeTimerCount(), 0, 'sin montar no hay relojes');

    handler.setupSocketServer(servidor);
    assert.equal(
      handler.activeTimerCount(),
      2,
      'al montar: vigilancia del consumidor lento y revisión de paneles',
    );

    const antes = relojesDelProceso();
    handler.broadcastBusPosition(posicion('APAGADO-1'));
    assert.equal(handler.activeTimerCount(), 3, 'y el del lote de esa ruta');
    assert.equal(
      relojesDelProceso(),
      antes + 1,
      'el del lote sostiene el proceso: es el único sin unref',
    );

    handler.closeSocketServer();
    assert.equal(handler.activeTimerCount(), 0, 'el apagado tiene que dejarlo en cero');
    assert.equal(relojesDelProceso(), antes, 'y devolver el proceso a como estaba');
    assert.equal(handler.getIO(), null, 'y soltar el servidor de sockets');
  } finally {
    await cerrar(servidor);
  }
});

test('montar dos veces no deja relojes huérfanos', async () => {
  const servidor = createServer();
  await escuchar(servidor);
  try {
    handler.setupSocketServer(servidor);
    handler.setupSocketServer(servidor);
    assert.equal(handler.activeTimerCount(), 2, 'la segunda vuelta no duplica la vigilancia');
    handler.closeSocketServer();
    assert.equal(handler.activeTimerCount(), 0);
  } finally {
    await cerrar(servidor);
  }
});

test('apagar dos veces seguidas no revienta', () => {
  handler.closeSocketServer();
  assert.equal(handler.activeTimerCount(), 0);
  assert.equal(handler.getIO(), null);
});
