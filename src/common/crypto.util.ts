import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Application-level at-rest encryption (AES-256-GCM), Discord-style:
 * the server CAN read plaintext (needed for search / moderation), but the
 * data stored on disk / in the DB is encrypted. A leaked DB dump alone is
 * useless without the DM_ENCRYPTION_KEY.
 *
 * Format stored: base64( iv(12) | authTag(16) | ciphertext )
 */
export class AtRestCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Normalize any provided secret to a stable 32-byte key.
    this.key = createHash('sha256').update(secret).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  decrypt(payload: string): string {
    try {
      const buf = Buffer.from(payload, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(enc),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Corrupt / wrong-key data: return empty rather than crash a list.
      return '';
    }
  }
}
