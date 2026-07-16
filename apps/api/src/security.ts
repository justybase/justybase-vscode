import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PASSWORD_KEY_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;
const ENCRYPTION_IV_BYTES = 12;

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const derived = scryptSync(password, salt, PASSWORD_KEY_BYTES);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, encodedSalt, encodedHash] = encoded.split('$');
  if (algorithm !== 'scrypt' || !encodedSalt || !encodedHash) {
    return false;
  }
  const salt = Buffer.from(encodedSalt, 'base64url');
  const expected = Buffer.from(encodedHash, 'base64url');
  const actual = scryptSync(password, salt, PASSWORD_KEY_BYTES);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function deriveEncryptionKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

export function encryptSecret(value: string, masterKey: string): EncryptedSecret {
  const iv = randomBytes(ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveEncryptionKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptSecret(secret: EncryptedSecret, masterKey: string): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveEncryptionKey(masterKey),
    Buffer.from(secret.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(secret.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
