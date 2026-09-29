import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const KEY_LENGTH = 64;

export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(secret, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

export function verifySecret(secret: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;

  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = scryptSync(secret, salt, KEY_LENGTH);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Como [verifySecret], pero cuesta lo mismo haya cuenta o no (auditoría
 * 2026-09, P3-1). Sin cuenta —o sin hash— no se corría scrypt y el 401 salía
 * decenas de ms antes: midiendo la respuesta se sabía qué teléfonos y qué
 * usuarios existen. Aquí se corre contra un hash de relleno y se devuelve
 * `false` igual.
 */
export function verifySecretSinDelatar(secret: string, storedHash: string | null | undefined): boolean {
  if (storedHash) return verifySecret(secret, storedHash);
  verifySecret(secret, hashDeRelleno());
  return false;
}

let relleno: string | null = null;
function hashDeRelleno(): string {
  relleno ??= hashSecret(randomBytes(16).toString('hex'));
  return relleno;
}

export const hashPin = hashSecret;
export const verifyPin = verifySecret;
