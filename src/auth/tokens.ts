import jwt from 'jsonwebtoken';

const configuredSecret = process.env.JWT_SECRET;
if (!configuredSecret && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET is required in production');
}

const JWT_SECRET = configuredSecret || 'ya-viene-local-development-secret';
const JWT_ISSUER = 'ya-viene-backend';
const JWT_AUDIENCE = 'ya-viene-mqtt';

export interface TokenPayload {
  sub: string;
  driverId: string;
  phoneNumber: string;
  role: 'driver';
  companyId: string;
  busId: string;
  routeId: string;
  sessionId: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: '24h',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    if (!decoded || typeof decoded !== 'object') return null;

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

    return decoded as TokenPayload;
  } catch {
    return null;
  }
}
