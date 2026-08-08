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
}

export type TokenPayload = DriverTokenPayload | AdminTokenPayload;

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, jwtSecret(), {
    expiresIn: '24h',
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
