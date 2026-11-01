import { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';
import { TokenPayload, verifyToken, AdminTokenPayload } from './tokens';
import { getSession } from '../data/sessions';
import { isAdminTokenCurrent } from '../data/empresas';
import { leerCookiePanel } from './cookie_panel';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_API_KEY && process.env.NODE_ENV === 'production') {
  throw new Error('ADMIN_API_KEY es obligatoria en producción');
}

/**
 * El `Bearer` primero; sin cabecera, la cookie del panel web. Si llegan los
 * dos manda el `Bearer` y la cookie ni se mira. La cookie solo vale para un
 * token de panel: nadie emite una con otro, y no se le abre esa puerta al
 * del conductor. Que una escritura con cookie traiga además el Origin del
 * panel lo exige `handleAPI` antes de llegar aquí.
 */
export function authenticateRequest(req: IncomingMessage): TokenPayload | null {
  const header = req.headers.authorization;
  if (header !== undefined) {
    if (!header.startsWith('Bearer ')) return null;
    return verifyToken(header.slice('Bearer '.length).trim());
  }
  const deCookie = leerCookiePanel(req.headers);
  if (!deCookie) return null;
  const payload = verifyToken(deCookie);
  return payload?.role === 'admin' ? payload : null;
}

export function authenticateCompanyAdmin(req: IncomingMessage): AdminTokenPayload | null {
  const auth = authenticateRequest(req);
  if (auth?.role !== 'admin') return null;
  // La firma solo prueba que el token lo emitimos nosotros, no que la
  // contraseña con la que se entró siga siendo la buena: eso lo dice la base.
  return isAdminTokenCurrent(auth.sub, auth.companyId, auth.tv) ? auth : null;
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

export function isDeviceForBus(auth: TokenPayload | null, busId: string): boolean {
  if (!auth || auth.role !== 'device' || auth.busId !== busId) return false;
  const session = getSession(auth.sessionId);
  return session?.status === 'active' &&
      session.deviceId === auth.deviceId &&
      session.busId === auth.busId;
}
