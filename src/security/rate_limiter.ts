import { IncomingMessage } from 'http';

import { setMetric } from '../observability/metrics';

/**
 * Limitador de ventana deslizante: el presupuesto se recupera a medida que
 * los intentos individuales salen de la ventana, así que no existe el borde
 * de ventana fija donde caben 2× maxRequests en dos segundos seguidos.
 *
 * La memoria está acotada por diseño:
 * - Cada clave guarda como máximo `maxRequests` marcas de tiempo.
 * - Un barrido periódico (cada `sweepEvery` llamadas a [allow], o manual
 *   con [sweep]) elimina las claves que llevan `windowMs` sin actividad.
 *   Sin él, detrás de un túnel donde cada visitante trae una IP distinta,
 *   el mapa crece para siempre.
 */
export class SlidingWindowRateLimiter {
  private readonly entries = new Map<string, number[]>();
  private callsSinceSweep = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly sweepEvery = 64,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    if (++this.callsSinceSweep >= this.sweepEvery) {
      this.callsSinceSweep = 0;
      this.sweep(now);
    }

    const hits = this.entries.get(key);
    const vivas = hits ? hits.filter((t) => now - t < this.windowMs) : [];
    if (vivas.length >= this.maxRequests) {
      // Conserva solo las vivas: las vencidas no vuelven a contar y no
      // deben ocupar sitio en el array.
      this.entries.set(key, vivas);
      return false;
    }
    vivas.push(now);
    this.entries.set(key, vivas);
    return true;
  }

  /** Elimina las claves sin actividad dentro de la ventana. Devuelve cuántas. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, hits] of this.entries) {
      const vivas = hits.filter((t) => now - t < this.windowMs);
      if (vivas.length === 0) {
        this.entries.delete(key);
        removed += 1;
      } else if (vivas.length !== hits.length) {
        this.entries.set(key, vivas);
      }
    }
    return removed;
  }

  /** Claves actualmente recordadas (uso en tests y métricas). */
  get size(): number {
    return this.entries.size;
  }
}

// 5 logins por minuto por IP es generoso para una persona y frena el
// bombardeo de PIN; el admin mueve más (provisión, rutas, buses) y lleva 20.
export const loginRateLimiter = new SlidingWindowRateLimiter(5, 60_000);
// El de arriba cuenta por (IP, cuenta), así que quien prueba una cuenta
// distinta en cada intento estrena presupuesto cada vez: con una lista de
// teléfonos y el PIN '1234' se pueden barrer cientos de cuentas por minuto
// desde una sola IP sin tocar nunca el tope. Este segundo cuenta todos los
// intentos de una IP juntos y pone el techo a esa barrida. 20/min deja sitio
// a un teléfono compartido o a una oficina detrás de un NAT pequeño —cuatro
// personas equivocándose seguido— y aun así corta el barrido.
export const loginIpRateLimiter = new SlidingWindowRateLimiter(20, 60_000);
export const adminRateLimiter = new SlidingWindowRateLimiter(20, 60_000);
// Lecturas públicas: la app del pasajero refresca posiciones cada pocos
// segundos y el catálogo casi no cambia; 120/min por IP deja trabajar a la
// app y frena el scraping burdo sin tocar a quien la usa de verdad.
export const readRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
// Cambios de flota que no tenían tope: visibilidad (de un bus o de todos),
// editar o borrar un bus y borrar una ruta. Van con token de empresa, así que
// no es un ataque de adivinanza, pero sin límite un token filtrado —o un
// script mal hecho— podía martillar escrituras en SQLite sin freno. 60/min
// deja a una persona ocultar treinta buses uno a uno sin tropezar.
export const fleetWriteRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

const LIMITADORES: Record<string, SlidingWindowRateLimiter> = {
  login: loginRateLimiter,
  loginIp: loginIpRateLimiter,
  admin: adminRateLimiter,
  read: readRateLimiter,
  fleetWrite: fleetWriteRateLimiter,
};

// La memoria de cada limitador está acotada por el barrido, pero nadie la
// veía: detrás de un túnel donde cada visitante trae una IP distinta, el
// número de claves es lo único que dice si el tráfico es el de siempre o un
// barrido desde muchas direcciones. 10 000 claves son unos pocos MB y muchas
// más IP de las que junta la demo en un minuto: pasar de ahí merece una
// línea en el log, no una alarma.
const AVISO_CLAVES = 10_000;
const yaAvisados = new Set<string>();

/**
 * Publica cuántas claves recuerda cada limitador (`ratelimit.<nombre>.claves`)
 * y avisa en el log cuando alguno pasa de [AVISO_CLAVES]. Avisa una vez por
 * subida y no en cada volcado: si se queda arriba media hora, son sesenta
 * líneas iguales que esconden las demás. Cuando baja, la siguiente subida
 * vuelve a avisar. Corre con el volcado de métricas (`index.ts`).
 */
export function registrarTamanosLimitadores(
  limitadores: Record<string, SlidingWindowRateLimiter> = LIMITADORES,
  avisar: (mensaje: string) => void = console.warn,
): void {
  for (const [nombre, limitador] of Object.entries(limitadores)) {
    const claves = limitador.size;
    setMetric(`ratelimit.${nombre}.claves`, claves);
    if (claves <= AVISO_CLAVES) {
      yaAvisados.delete(nombre);
    } else if (!yaAvisados.has(nombre)) {
      yaAvisados.add(nombre);
      avisar(`[RateLimit] ${nombre} recuerda ${claves} claves (aviso desde ${AVISO_CLAVES}): mucho tráfico desde direcciones distintas`);
    }
  }
}

// Solo confiamos en X-Forwarded-For si la conexión TCP viene del túnel local
// (ngrok/cloudflared corren en loopback en este despliegue, confirmado con
// el inspector de ngrok en 127.0.0.1:4040). Si no, el cliente no puede fijar
// su propia key con una cabecera falsa.
const TRUSTED_PROXY_ADDRESSES = new Set(['127.0.0.1', '::1']);

// El servidor escucha en '::', así que una conexión IPv4 llega como IPv4
// mapeada en IPv6: '::ffff:127.0.0.1' es el mismo 127.0.0.1 de siempre. Sin
// quitar el prefijo, el túnel en loopback no se reconoce como de confianza
// —se ignora X-Forwarded-For— y todos los que entran por él comparten una
// sola clave. Solo se quita cuando lo que sigue tiene forma de IPv4: en una
// IPv6 legítima el mismo prefijo puede ir seguido de hexadecimal.
const IPV4_MAPEADA = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function normalizarIp(direccion: string): string {
  const mapeada = IPV4_MAPEADA.exec(direccion);
  return mapeada ? mapeada[1] : direccion;
}

export function requestKey(req: IncomingMessage, suffix = ''): string {
  // En Fly (el respaldo) no hay túnel en loopback: todo llega desde el
  // proxy de Fly por su red privada, así que la IP del socket era la del
  // proxy y TODOS los pasajeros compartían un único cupo —con 120 lecturas
  // por minuto para el país entero, el respaldo se ahogaba en cuanto la app
  // conmutaba a él. El proxy de Fly pone la IP real en Fly-Client-IP y
  // pisa la que mande el cliente; FLY_APP_NAME solo existe dentro de una
  // máquina de Fly, así que fuera de ella la cabecera no se mira.
  const flyClientIp = process.env.FLY_APP_NAME ? req.headers['fly-client-ip'] : undefined;
  if (typeof flyClientIp === 'string' && flyClientIp.trim()) {
    const ip = flyClientIp.trim();
    return suffix ? `${ip}:${suffix}` : ip;
  }
  const remota = normalizarIp(req.socket.remoteAddress ?? '');
  const trustedProxy = TRUSTED_PROXY_ADDRESSES.has(remota);
  const forwarded = trustedProxy ? req.headers['x-forwarded-for'] : undefined;
  const ip = typeof forwarded === 'string'
    ? forwarded.split(',').pop()!.trim() // último hop = el que agregó el proxy
    : remota || 'unknown';
  return suffix ? `${ip}:${suffix}` : ip;
}
