import type { Server } from 'node:net';

// Fuera de producción el API solo atiende a esta misma máquina.
//
// `index.ts` escucha en '::' para que `localhost` funcione en doble pila, y
// eso abre el puerto a toda la red donde esté el Mac: en la Wi-Fi de la sala
// del pitch cualquiera alcanzaba el API —y el MQTT por WebSocket, que va por
// el mismo HTTP— en claro, sin pasar por ngrok ni por TLS. Atar el servidor a
// una sola dirección de loopback no alcanza: ngrok llega por `[::1]`, la
// flota demo llama a `127.0.0.1` y el panel local usa `localhost`. Así que se
// sigue escuchando en '::' y se cierra al conectar todo lo que no venga de
// loopback, antes de leer un solo byte.
//
// En producción (Fly) el tráfico llega del proxy de Fly, que no es loopback:
// allí no se cierra nada. `HTTP_ALLOW_REMOTE=1` abre también fuera de
// producción, para quien necesite el backend por la red local sin ngrok;
// `validateConfig` lo avisa al arrancar, igual que un MQTT expuesto.

/** Si `direccion` es esta misma máquina: 127/8, `::1` o 127/8 mapeada a IPv6. */
export function esLoopback(direccion: string | undefined): boolean {
  if (!direccion) return false;
  if (direccion === '::1') return true;
  const v4 = direccion.startsWith('::ffff:') ? direccion.slice(7) : direccion;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Si el API atiende conexiones de fuera de esta máquina. */
export function aceptaRemotos(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.HTTP_ALLOW_REMOTE === '1';
}

/**
 * Cierra al conectar los sockets que no vienen de loopback, salvo que
 * [aceptaRemotos]. Se engancha a `connection`, que salta antes de que el
 * HTTP lea la petición: quien viene de la red no recibe ni un 403, solo una
 * conexión cerrada, y no aprende nada de lo que hay detrás.
 */
export function cerrarRedLocal(server: Server, env: NodeJS.ProcessEnv = process.env): void {
  if (aceptaRemotos(env)) return;
  server.on('connection', (socket) => {
    if (!esLoopback(socket.remoteAddress)) socket.destroy();
  });
}
