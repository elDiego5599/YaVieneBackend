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

export const hashPin = hashSecret;
export const verifyPin = verifySecret;
