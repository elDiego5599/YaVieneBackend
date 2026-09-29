import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, Server as HTTPServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as conectar, Socket } from 'socket.io-client';
import type { BusPosition } from '../src/data/bus_types';

/*
  T7.9 — fugas del backend.

  Un pasajero entra, mira una ruta, cambia a otra y se va; el panel abre y
  cierra. Eso pasa miles de veces en una jornada, y cada vuelta deja sitios
  donde algo se puede quedar pegado: la sala de la ruta, la cuenta de
  sockets por dirección y el reloj del lote de posiciones de esa ruta. Si
  alguno no se suelta, el servidor no se cae hoy: se va llenando y se cae de
  madrugada, que es cuando nadie mira.

  Esta prueba hace ese ir y venir 200 veces contra el servidor de sockets de
  verdad, en este mismo proceso —que es la única forma de mirarle las
  estructuras por dentro— y exige que al final todo quede como al empezar.
  La corrida larga de una hora con carga (T7.2) sigue siendo del piloto;
  esto es lo que puede correr en cada commit.

  La ruta de la base se lee al cargar el módulo (`data/database.ts`), así que
  se fija ANTES del primer import que llegue hasta ella.
*/
const carpeta = mkdtempSync(join(tmpdir(), 'yaviene-fugas-'));
process.env.YA_VIENE_DB_PATH = join(carpeta, 'fugas.db');
process.env.JWT_SECRET = 'test-jwt-secret';

type ModuloHandler = typeof import('../src/socket/handler');
let handler: ModuloHandler;

// Fuera de producción la base nueva nace con el catálogo de Sobusa
// (`siembraDemoHabilitada`), así que `subscribe:route` acepta estas rutas
// sin sembrar nada a mano.
const RUTAS = ['R-101', 'R-102', 'R-103'];
const VUELTAS = 200;
const A_LA_VEZ = 20;

const escuchar = (servidor: HTTPServer): Promise<number> =>
  new Promise((listo) => {
    servidor.listen(0, '127.0.0.1', () => {
      const dir = servidor.address();
      listo(typeof dir === 'object' && dir ? dir.port : 0);
    });
  });

const cerrar = (servidor: HTTPServer): Promise<void> =>
  new Promise((listo) => {
    if (!servidor.listening) {
      listo();
      return;
    }
    servidor.close(() => listo());
  });

const esperar = (ms: number): Promise<void> =>
  new Promise((listo) => setTimeout(listo, ms));

const posicion = (routeId: string, busId: string): BusPosition => ({
  busId,
  routeId,
  lat: 10.9878,
  lon: -74.7889,
  heading: null,
  speedKmh: 12,
  sentido: null,
  timestamp: new Date().toISOString(),
  capturedAt: Date.now(),
  receivedAt: Date.now(),
  sequence: 1,
  driverPhone: '',
  companyId: 'EMPRESA-FUGAS',
  isGhost: false,
});

/** Un pasajero: entra, mira dos rutas, deja una, y se va. */
async function unPasajero(puerto: number, vuelta: number): Promise<void> {
  const cliente: Socket = conectar(`http://127.0.0.1:${puerto}`, {
    path: '/ws',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  await new Promise<void>((listo, falla) => {
    cliente.once('connect', () => listo());
    cliente.once('connect_error', falla);
  });
  const primera = RUTAS[vuelta % RUTAS.length];
  const segunda = RUTAS[(vuelta + 1) % RUTAS.length];
  cliente.emit('subscribe:route', primera);
  cliente.emit('subscribe:route', segunda);
  await esperar(5);
  cliente.emit('unsubscribe:route', primera);
  await esperar(5);
  cliente.close();
}

test('setup: carga el socket contra una base temporal', async () => {
  handler = await import('../src/socket/handler');
  assert.equal(
    typeof handler.activeAddressCount,
    'function',
    'hace falta poder contar las direcciones con sockets abiertos',
  );
});

test('doscientas idas y venidas no dejan nada pegado', { timeout: 120_000 }, async () => {
  const servidor = createServer();
  const puerto = await escuchar(servidor);
  try {
    const io = handler.setupSocketServer(servidor);

    for (let desde = 0; desde < VUELTAS; desde += A_LA_VEZ) {
      await Promise.all(
        Array.from({ length: A_LA_VEZ }, (_, i) => unPasajero(puerto, desde + i)),
      );
      // Tráfico mientras tanto: cada posición abre el lote de su ruta, que
      // es el único reloj del módulo que no lleva `unref`.
      for (const ruta of RUTAS) {
        handler.broadcastBusPosition(posicion(ruta, `BUS-${desde}`));
      }
      await esperar(20);
    }

    // El servidor se entera del último cierre un instante después que el
    // cliente, y el lote tarda 100 ms en vaciarse.
    await esperar(600);

    assert.equal(io.sockets.sockets.size, 0, 'no puede quedar ningún socket abierto');
    assert.equal(
      io.of('/').adapter.rooms.size,
      0,
      'ni una sala: las de ruta se vacían al irse el último que miraba',
    );
    assert.equal(
      handler.activeAddressCount(),
      0,
      'la cuenta de sockets por dirección tiene que volver a cero',
    );
    assert.equal(
      handler.activeTimerCount(),
      2,
      'solo los dos de vigilancia: ni un reloj de lote suelto',
    );
  } finally {
    handler.closeSocketServer();
    await cerrar(servidor);
  }
});

test('apagar el socket no se deja direcciones apuntadas', { timeout: 30_000 }, async () => {
  const servidor = createServer();
  const puerto = await escuchar(servidor);
  const clientes: Socket[] = [];
  try {
    handler.setupSocketServer(servidor);
    for (let i = 0; i < 3; i++) {
      const cliente = conectar(`http://127.0.0.1:${puerto}`, {
        path: '/ws',
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      clientes.push(cliente);
      await new Promise<void>((listo, falla) => {
        cliente.once('connect', () => listo());
        cliente.once('connect_error', falla);
      });
    }
    assert.equal(handler.activeAddressCount(), 1, 'las tres vienen de la misma dirección');

    // Apagar y volver a montar es lo que pasa en cada reinicio del proceso
    // de pruebas y en cualquier arranque en caliente: si la cuenta se queda
    // con lo de antes, el tope de sockets por dirección empieza gastado y
    // acaba rechazando a quien no debe.
    handler.closeSocketServer();
    assert.equal(
      handler.activeAddressCount(),
      0,
      'el apagado tiene que soltar también las direcciones',
    );
  } finally {
    for (const cliente of clientes) cliente.close();
    handler.closeSocketServer();
    await cerrar(servidor);
  }
});
