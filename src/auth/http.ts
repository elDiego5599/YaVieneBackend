import { IncomingMessage } from 'http';
import { TokenPayload, verifyToken } from './tokens';
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

export function isAdminRequest(req: IncomingMessage): boolean {
  if (!ADMIN_API_KEY) return false;
  return req.headers['x-admin-key'] === ADMIN_API_KEY;
}

export function isDriverForBus(auth: TokenPayload | null, busId: string): boolean {
  if (!auth || auth.role !== 'driver' || auth.busId !== busId) return false;
  const session = getSession(auth.sessionId);
  return session?.status === 'active' &&
      session.driverId === auth.driverId &&
      session.busId === auth.busId;
}
