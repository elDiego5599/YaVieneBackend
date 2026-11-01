import jwt from 'jsonwebtoken';

// Se lee en cada uso para que tests/entornos puedan fijarlo antes; la
// guardia de arranque (index.ts) impide arrancar sin JWT_SECRET para que
// nunca se roten tokens en silencio (apps con "sesión expiró").
const JWT_ISSUER = 'ya-viene-backend';
const JWT_AUDIENCE = 'ya-viene-mqtt';
// Uno solo, fijado al firmar y al verificar (auditoría 2026-09, P3-7). Sin
// la lista, `verify` acepta cualquier HMAC que valide con el secreto: hoy es
// seguro, pero deja la puerta a un cambio de librería o de clave que la
// abra. HS256 es el que ya se usaba, así que ningún token vivo se cae.
const JWT_ALGORITMO = 'HS256';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no configurado');
  return secret;
}

export interface DeviceTokenPayload {
  sub: string;
  deviceId: string;
  identifier: string;
  role: 'device';
  companyId: string;
  busId: string;
  routeId: string;
  sessionId: string;
}

export interface AdminTokenPayload {
  sub: string;
  role: 'admin';
  companyId: string;
  username: string;
  /**
   * Versión de la credencial con la que se firmó (`empresa_admins.token_version`).
   * Sin ella el token del panel valía sus 8 horas pasara lo que pasara: si a
   * una empresa le robaban la contraseña y la cambiaban, quien la tenía
   * seguía dentro hasta que el token caducara. Cada cambio de contraseña
   * sube la versión en la base y `authenticateCompanyAdmin` rechaza los
   * tokens firmados con una anterior.
   */
  tv: number;
  /**
   * Cuándo se entró con la contraseña, en segundos (el `auth_time` de OIDC).
   * Renovar firma un token nuevo cada 8 horas pero copia este inicio, así que
   * una sesión robada no se estira para siempre: a los `SESION_ADMIN_MAX_S`
   * de entrar deja de validar (AUD29-09).
   */
  auth_time: number;
}

/** Al firmar, el inicio es ahora salvo que se renueve una sesión que ya lo trae. */
export type AdminTokenFirma = Omit<AdminTokenPayload, 'auth_time'> & { auth_time?: number };

export type TokenPayload = DeviceTokenPayload | AdminTokenPayload;

/** Lo que dura el token del panel: 8 h, una jornada. La cookie del panel web
 * (`cookie_panel.ts`) dura lo mismo. */
export const ADMIN_TOKEN_TTL_S = 8 * 60 * 60;

/** Lo más que dura una sesión del panel desde que se entró: 30 días, un mes
 * de jornadas renovadas sin volver a poner la contraseña. */
export const SESION_ADMIN_MAX_S = 30 * 24 * 60 * 60;

export function signToken(payload: DeviceTokenPayload | AdminTokenFirma): string {
  const claims = payload.role === 'admin'
    ? { ...payload, auth_time: payload.auth_time ?? Math.floor(Date.now() / 1000) }
    : payload;
  return jwt.sign(claims, jwtSecret(), {
    // El token del panel dura una jornada: es la llave de toda la flota y
    // suele quedarse abierto en un computador de oficina. El del conductor
    // sigue en 24h a propósito, porque es el que sostiene la conexión MQTT
    // del bus: expirarlo a las 8 horas dejaría al bus mudo a media jornada.
    expiresIn: payload.role === 'admin' ? ADMIN_TOKEN_TTL_S : '24h',
    algorithm: JWT_ALGORITMO,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, jwtSecret(), {
      algorithms: [JWT_ALGORITMO],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    if (!decoded || typeof decoded !== 'object') return null;

    if (decoded.role === 'admin') {
      const required = ['sub', 'companyId', 'username'];
      if (!required.every((key) => typeof decoded[key] === 'string' && decoded[key])) {
        return null;
      }
      // Los tokens emitidos antes de que existiera la versión no la traen:
      // se rechazan y el panel pide entrar otra vez, que es una sola vez.
      if (!Number.isInteger(decoded.tv)) return null;
      // Sin inicio (anterior a AUD29-09), con uno del futuro o con más de
      // SESION_ADMIN_MAX_S encima, toca volver a entrar.
      const edad = Math.floor(Date.now() / 1000) - decoded.auth_time;
      if (!Number.isInteger(decoded.auth_time) || edad < 0 || edad > SESION_ADMIN_MAX_S) return null;
      return decoded as AdminTokenPayload;
    }

    const requiredStrings = ['sub', 'deviceId', 'identifier', 'companyId', 'busId', 'routeId', 'sessionId'];
    if (!requiredStrings.every((key) => typeof decoded[key] === 'string' && decoded[key])) {
      return null;
    }
    if (decoded.role !== 'device') return null;
    return decoded as DeviceTokenPayload;
  } catch {
    return null;
  }
}
