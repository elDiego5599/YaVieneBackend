import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, Server as HTTPServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { io as conectar, Socket } from 'socket.io-client';
import type { BusPosition } from '../src/data/bus_types';

/*
  T8.8 — catálogo de caos, los escenarios que faltaban.

  El catálogo tiene doce situaciones feas y diez ya tenían prueba en otro
  archivo (base dañada, reinicio, outbox podrido, MQTT y socket malformados,
  reloj corrido, desorden, token revocado). Aquí van las tres que nadie
  cubría, todas contra el servidor de sockets de verdad:

  - mil pasajeros mirando a la vez;
  - un cliente que deja de leer y se queda pegado;
  - la misma posición publicada dos veces seguidas.

  La ruta de la base se lee al cargar el módulo, y el tope de sockets por
  dirección también: los dos se fijan antes del primer import.
*/
const carpeta = mkdtempSync(join(tmpdir(), 'yaviene-caos-'));
process.env.YA_VIENE_DB_PATH = join(carpeta, 'caos.db');
process.env.JWT_SECRET = 'test-jwt-secret';
// En producción el tope son 100 sockets por dirección: aquí los mil clientes
// salen todos de loopback, así que sin subirlo esta prueba mediría el tope y
// no el aguante. El tope tiene su propia prueba en `sockets_por_ip.test.ts`.
process.env.YA_VIENE_MAX_SOCKETS_IP = '1200';

type ModuloHandler = typeof import('../src/socket/handler');
let handler: ModuloHandler;

const RUTAS = ['R-101', 'R-102', 'R-103'];
const PASAJEROS = 1000;
const A_LA_VEZ = 50;

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

/** Espera a que `condicion` se cumpla, mirando cada 50 ms. */
async function hasta(condicion: () => boolean, ms: number): Promise<boolean> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (condicion()) return true;
    await esperar(50);
  }
  return condicion();
}

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
  companyId: 'EMPRESA-CAOS',
  isGhost: false,
});

function abrir(puerto: number): Promise<Socket> {
  const cliente = conectar(`http://127.0.0.1:${puerto}`, {
    path: '/ws',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((listo, falla) => {
    cliente.once('connect', () => listo(cliente));
    cliente.once('connect_error', falla);
  });
}

test('setup: carga el socket contra una base temporal', async () => {
  handler = await import('../src/socket/handler');
});

test('mil pasajeros a la vez reciben lo suyo y solo lo suyo', { timeout: 180_000 }, async () => {
  const servidor = createServer();
  const puerto = await escuchar(servidor);
  const clientes: Socket[] = [];
  try {
    const io = handler.setupSocketServer(servidor);
    const recibido: string[][] = [];

    for (let desde = 0; desde < PASAJEROS; desde += A_LA_VEZ) {
      const tanda = await Promise.all(
        Array.from({ length: A_LA_VEZ }, () => abrir(puerto)),
      );
      for (const cliente of tanda) {
        const i = clientes.length;
        const mio: string[] = [];
        recibido.push(mio);
        cliente.on('bus:position', (bus: { busId?: string }) => {
          mio.push(String(bus?.busId ?? ''));
        });
        cliente.emit('subscribe:route', RUTAS[i % RUTAS.length]);
        clientes.push(cliente);
      }
    }

    assert.equal(
      await hasta(() => io.sockets.sockets.size === PASAJEROS, 30_000),
      true,
      `el servidor tiene que sostener los ${PASAJEROS}, no ${io.sockets.sockets.size}`,
    );
    // Las suscripciones viajan por el mismo socket que el handshake, pero se
    // atienden después: sin esto el reparto sale antes de que las salas
    // estén hechas.
    await esperar(1000);

    for (const ruta of RUTAS) {
      handler.broadcastBusPosition(posicion(ruta, `BUS-${ruta}`), true);
    }

    assert.equal(
      await hasta(() => recibido.every((lista) => lista.length === 1), 30_000),
      true,
      'a cada pasajero le tiene que llegar exactamente una posición',
    );
    for (let i = 0; i < recibido.length; i++) {
      assert.deepEqual(
        recibido[i],
        [`BUS-${RUTAS[i % RUTAS.length]}`],
        'a nadie le puede llegar el bus de una ruta que no está mirando',
      );
    }
  } finally {
    for (const cliente of clientes) cliente.close();
    handler.closeSocketServer();
    await cerrar(servidor);
  }
});

test('un cliente que deja de leer no frena a los demás', { timeout: 120_000 }, async () => {
  const servidor = createServer();
  const puerto = await escuchar(servidor);
  let pegado: WebSocket | null = null;
  let sano: Socket | null = null;
  try {
    const io = handler.setupSocketServer(servidor);

    // Socket.IO por dentro: `40` entra al espacio de nombres y `42[...]` es
    // un evento. Se habla en crudo porque el cliente normal lee solo y aquí
    // hace falta uno que deje de leer a propósito.
    pegado = new WebSocket(`ws://127.0.0.1:${puerto}/ws/?EIO=4&transport=websocket`);
    await new Promise<void>((listo, falla) => {
      pegado!.once('open', () => listo());
      pegado!.once('error', falla);
    });
    pegado.send('40');
    await esperar(200);
    pegado.send(`42["subscribe:route","${RUTAS[0]}"]`);
    await esperar(200);

    sano = await abrir(puerto);
    const suyas: string[] = [];
    sano.on('bus:position', (bus: { busId?: string }) => {
      suyas.push(String(bus?.busId ?? ''));
    });
    sano.emit('subscribe:route', RUTAS[0]);
    await esperar(300);

    // Deja de leer: el sistema operativo le llena el buzón y el servidor se
    // queda con lo escrito sin acusar. Desde aquí, el servidor no puede
    // distinguirlo de un teléfono que se metió en un ascensor.
    (pegado as unknown as { _socket: { pause(): void } })._socket.pause();

    for (let i = 0; i < 300; i++) {
      handler.broadcastBusPosition(posicion(RUTAS[0], `BUS-${i}`), true);
    }

    assert.equal(
      await hasta(() => suyas.length >= 300, 30_000),
      true,
      `al cliente sano le tienen que llegar las 300, no ${suyas.length}`,
    );

    // El pegado no contesta el latido (pingInterval 10 s + pingTimeout 5 s),
    // así que el servidor lo suelta solo. Si no lo soltara, cada teléfono
    // que se queda sin cobertura dejaría una conexión ocupada para siempre.
    assert.equal(
      await hasta(() => io.sockets.sockets.size === 1, 40_000),
      true,
      'el que dejó de leer tiene que acabar fuera, y el sano dentro',
    );
    assert.equal(sano.connected, true, 'el sano no se puede haber caído con él');
  } finally {
    pegado?.terminate();
    sano?.close();
    handler.closeSocketServer();
    await cerrar(servidor);
  }
});

test('la misma posición dos veces seguidas llega una sola vez', { timeout: 60_000 }, async () => {
  const servidor = createServer();
  const puerto = await escuchar(servidor);
  let cliente: Socket | null = null;
  try {
    handler.setupSocketServer(servidor);
    cliente = await abrir(puerto);
    const sueltas: string[] = [];
    const lotes: number[] = [];
    cliente.on('bus:position', (bus: { busId?: string }) => {
      sueltas.push(String(bus?.busId ?? ''));
    });
    cliente.on('positions:update', (lote: { buses?: unknown[] }) => {
      lotes.push(lote?.buses?.length ?? 0);
    });
    cliente.emit('subscribe:route', RUTAS[0]);
    await esperar(300);

    // El equipo del bus reenvía la misma posición (la red le repitió el
    // paquete, o el reintento llegó tarde). Las dos caen en la misma ventana
    // de 100 ms del lote, y el lote guarda una por bus: al pasajero le llega
    // un punto, no dos, y su mapa no parpadea.
    const p = posicion(RUTAS[0], 'BUS-REPETIDO');
    handler.broadcastBusPosition(p);
    handler.broadcastBusPosition({ ...p });

    await esperar(600);
    assert.deepEqual(sueltas, ['BUS-REPETIDO'], 'la repetida no puede salir dos veces');
    assert.deepEqual(lotes, [], 'con un solo bus no hay lote que mandar');
  } finally {
    cliente?.close();
    handler.closeSocketServer();
    await cerrar(servidor);
  }
});
