import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/*
 * Secrets at rest (API keys, OAuth tokens, SMB passwords) are encrypted with AES-256-GCM.
 * Key: APP_SECRET if set, otherwise a random key generated once into <data>/app.key.
 * Losing the key makes stored secrets unreadable (users would re-enter keys / reconnect).
 */

const PREFIX = 'v1:';
let key: Buffer | undefined;

export function appKey(): Buffer {
  if (key) return key;
  if (process.env.APP_SECRET) {
    key = createHash('sha256').update(process.env.APP_SECRET).digest();
    return key;
  }
  const file = path.join(config.dataDir, 'app.key');
  if (!existsSync(file)) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    console.log('generated data/app.key (keep it with your backups)');
  }
  key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('data/app.key is not a valid 32-byte key');
  return key;
}

/** For tests. */
export function setKeyForTests(value: Buffer | undefined) { key = value; }

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', appKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decrypt(value: string): string {
  if (!value.startsWith(PREFIX)) throw new Error('Not an encrypted value');
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', appKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export const isEncrypted = (value: unknown): value is string => typeof value === 'string' && value.startsWith(PREFIX);

/** Encrypt a JSON object as a whole: stored as { enc: "v1:…" }. */
export function sealJson(value: Record<string, unknown>): { enc: string } | Record<string, never> {
  return Object.keys(value).length ? { enc: encrypt(JSON.stringify(value)) } : {};
}

/** Reverse of sealJson; plaintext objects (pre-encryption data) are returned as-is. */
export function openJson(stored: any): Record<string, any> {
  if (stored && isEncrypted(stored.enc)) return JSON.parse(decrypt(stored.enc));
  return stored && typeof stored === 'object' ? stored : {};
}
