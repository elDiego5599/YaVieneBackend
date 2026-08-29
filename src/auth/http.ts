import { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';
import { TokenPayload, verifyToken, AdminTokenPayload } from './tokens';
import { getSession } from '../data/sessions';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_API_KEY && process.env.NODE_ENV === 'production') {
  throw new Error('ADMIN_API_KEY is required in production');
}

export function authenticateRequest(req: IncomingMessage): TokenPayload | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifyToken(header.slice('Bearer '.length).trim());
}

export function authenticateCompanyAdmin(req: IncomingMessage): AdminTokenPayload | null {
  const auth = authenticateRequest(req);
  return auth?.role === 'admin' ? auth : null;
}

/**
 * La comparación es de tiempo constante, igual que la del PIN en
 * `passwords.ts`: `===` sobre cadenas corta en el primer byte distinto y le
 * va midiendo al atacante cuánto lleva acertado. `timingSafeEqual` exige
 * buffers del mismo largo, así que la diferencia de longitud se resuelve
 * aparte —y esa sí se puede medir, pero solo revela el largo de la clave.
 */
export function isAdminRequest(req: IncomingMessage): boolean {
  if (!ADMIN_API_KEY) return false;
  const provided = req.headers['x-admin-key'];
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_API_KEY);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isDriverForBus(auth: TokenPayload | null, busId: string): boolean {
  if (!auth || auth.role !== 'driver' || auth.busId !== busId) return false;
  const session = getSession(auth.sessionId);
  return session?.status === 'active' &&
      session.driverId === auth.driverId &&
      session.busId === auth.busId;
}
