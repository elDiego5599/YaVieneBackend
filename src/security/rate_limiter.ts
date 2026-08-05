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

export function requestKey(req: IncomingMessage, suffix = ''): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.socket.remoteAddress ?? 'unknown';
  return suffix ? `${ip}:${suffix}` : ip;
}
