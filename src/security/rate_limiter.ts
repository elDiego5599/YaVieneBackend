import { IncomingMessage } from 'http';

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

// Solo confiamos en X-Forwarded-For si la conexión TCP viene del túnel local
// (ngrok/cloudflared corren en loopback en este despliegue, confirmado con
// el inspector de ngrok en 127.0.0.1:4040). Si no, el cliente no puede fijar
// su propia key con una cabecera falsa.
const TRUSTED_PROXY_ADDRESSES = new Set(['127.0.0.1', '::1']);

export function requestKey(req: IncomingMessage, suffix = ''): string {
  const trustedProxy = TRUSTED_PROXY_ADDRESSES.has(req.socket.remoteAddress ?? '');
  const forwarded = trustedProxy ? req.headers['x-forwarded-for'] : undefined;
  const ip = typeof forwarded === 'string'
    ? forwarded.split(',').pop()!.trim() // último hop = el que agregó el proxy
    : req.socket.remoteAddress ?? 'unknown';
  return suffix ? `${ip}:${suffix}` : ip;
}
