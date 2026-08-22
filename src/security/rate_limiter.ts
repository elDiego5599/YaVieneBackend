import { IncomingMessage } from 'http';

interface WindowEntry {
  count: number;
  startedAt: number;
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const current = this.entries.get(key);

    if (!current || now - current.startedAt >= this.windowMs) {
      this.entries.set(key, { count: 1, startedAt: now });
      return true;
    }

    if (current.count >= this.maxRequests) return false;
    current.count += 1;
    return true;
  }
}

export const loginRateLimiter = new FixedWindowRateLimiter(5, 60_000);
export const adminRateLimiter = new FixedWindowRateLimiter(20, 60_000);

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
