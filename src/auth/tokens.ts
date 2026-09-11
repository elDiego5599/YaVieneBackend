import jwt from 'jsonwebtoken';

// Se lee en cada uso para que tests/entornos puedan fijarlo antes; la
// guardia de arranque (index.ts) impide arrancar sin JWT_SECRET para que
// nunca se roten tokens en silencio (apps con "sesión expiró").
const JWT_ISSUER = 'ya-viene-backend';
const JWT_AUDIENCE = 'ya-viene-mqtt';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no configurado');
  return secret;
}

export interface DriverTokenPayload {
  sub: string;
  driverId: string;
  phoneNumber: string;
  role: 'driver';
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
}

export type TokenPayload = DriverTokenPayload | AdminTokenPayload;

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, jwtSecret(), {
    // El token del panel dura una jornada: es la llave de toda la flota y
    // suele quedarse abierto en un computador de oficina. El del conductor
    // sigue en 24h a propósito, porque es el que sostiene la conexión MQTT
    // del bus: expirarlo a las 8 horas dejaría al bus mudo a media jornada.
    expiresIn: payload.role === 'admin' ? '8h' : '24h',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, jwtSecret(), {
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
      return decoded as AdminTokenPayload;
    }

    const requiredStrings = [
      'sub',
      'driverId',
      'phoneNumber',
      'companyId',
      'busId',
      'routeId',
      'sessionId',
    ];
    if (!requiredStrings.every((key) => typeof decoded[key] === 'string' && decoded[key])) {
      return null;
    }
    if (decoded.role !== 'driver') return null;

    return decoded as DriverTokenPayload;
  } catch {
    return null;
  }
}
