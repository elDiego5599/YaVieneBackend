import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'ya-viene-dev-secret-do-not-use-in-prod';

export interface TokenPayload {
  phoneNumber: string;
  busId: string;
  empresaId: string;
  role: 'driver';
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}
