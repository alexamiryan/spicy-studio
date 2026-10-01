import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { one, q } from './db.js';
import { ProviderError } from './providers/types.js';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const COOKIE = 'sid';
const TEN_YEARS = 10 * 365 * 24 * 3600;

// Passwords are hashed with argon2id (OWASP parameters). Hashes from before this (scrypt) still verify
// and are upgraded to argon2id at the user's next successful sign-in.
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string) {
  return argonHash(password, ARGON);
}

export const needsRehash = (stored: string) => !stored.startsWith('$argon2id$');

export async function verifyPassword(password: string, stored: string) {
  if (stored.startsWith('$argon2')) {
    try { return await argonVerify(stored, password); } catch { return false; }
  }
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Check a password and, if it's an old-format hash, upgrade it. */
async function checkAndUpgrade(userId: string, password: string, stored: string) {
  if (!(await verifyPassword(password, stored))) return false;
  if (needsRehash(stored)) await q('update users set password_hash = $2 where id = $1', [userId, await hashPassword(password)]);
  return true;
}

export const validPassword = (value: unknown) => typeof value === 'string' && value.length >= 8 && value.length <= 200;

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

declare module 'fastify' {
  interface FastifyRequest { userId?: string; sessionHash?: string; role?: 'admin' | 'user' }
}

/** For admin-only routes. */
export function requireAdmin(request: FastifyRequest) {
  if (request.role !== 'admin') throw new ProviderError('Not found.', 404);
}

/** Sign a user out everywhere, optionally keeping one session. */
export async function revokeSessions(userId: string, keepHash?: string) {
  await q('delete from sessions where user_id = $1 and token_hash is distinct from $2', [userId, keepHash ?? null]);
}

export function describeAgent(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

async function startSession(request: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = randomBytes(32).toString('base64url');
  await q('insert into sessions (token_hash, user_id, user_agent) values ($1, $2, $3)', [tokenHash(token), userId, String(request.headers['user-agent'] || '').slice(0, 400)]);
  reply.setCookie(COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: request.protocol === 'https', maxAge: TEN_YEARS,
  });
}

/** Create a user with their first workspace and empty settings. */
export async function createUser(username: string, password: string, role: 'admin' | 'user') {
  const user = await one<{ id: string }>('insert into users (username, password_hash, role) values ($1, $2, $3) returning id',
    [username, await hashPassword(password), role]);
  await q('insert into user_settings (user_id) values ($1) on conflict do nothing', [user!.id]);
  const { createWorkspace } = await import('./routes/workspace.js');
  await createWorkspace(user!.id, 'My workspace');
  return user!.id;
}

/** Empty database only: create the admin from ADMIN_USERNAME / ADMIN_PASSWORD. */
export async function seedAdmin() {
  if (!config.adminUsername || !config.adminPassword) return;
  if (await one('select id from users limit 1')) return;
  await createUser(config.adminUsername, config.adminPassword, 'admin');
  console.log(`created admin user ${config.adminUsername}`);
}

const PUBLIC_API = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/setup']);

export function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0];
    const protectedPath = url.startsWith('/api/') || url.startsWith('/media/');
    if (!protectedPath || PUBLIC_API.has(url)) return;
    const token = request.cookies[COOKIE];
    if (token) {
      const hash = tokenHash(token);
      const session = await one<{ user_id: string; last_seen: Date; role: 'admin' | 'user' }>(
        'select s.user_id, s.last_seen, u.role from sessions s join users u on u.id = s.user_id where s.token_hash = $1', [hash]);
      if (session) {
        request.userId = session.user_id;
        request.role = session.role;
        request.sessionHash = hash;
        if (Date.now() - new Date(session.last_seen).getTime() > 3600_000) {
          q('update sessions set last_seen = now() where token_hash = $1', [hash]).catch(() => {});
        }
        return;
      }
    }
    reply.code(401).send({ error: 'Please sign in.' });
  });

  app.get('/api/auth/status', async request => {
    const hasUser = Boolean(await one('select id from users limit 1'));
    const token = request.cookies[COOKIE];
    const session = token ? await one('select u.id, u.username, u.role from sessions s join users u on u.id = s.user_id where s.token_hash = $1', [tokenHash(token)]) : undefined;
    return { needsSetup: !hasUser, signedIn: Boolean(session), username: session?.username, role: session?.role, userId: session?.id };
  });

  app.post('/api/auth/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { username, password } = (request.body || {}) as { username?: string; password?: string };
    if (await one('select id from users limit 1')) throw new ProviderError('An account already exists. Sign in instead.', 409);
    const name = String(username || '').trim();
    if (!name || !validPassword(password)) throw new ProviderError('Choose a username and a password of at least 8 characters.', 400);
    const userId = await createUser(name, String(password), 'admin');
    await startSession(request, reply, userId);
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { username, password } = (request.body || {}) as { username?: string; password?: string };
    const user = await one<{ id: string; password_hash: string }>('select id, password_hash from users where lower(username) = lower($1)', [String(username || '').trim()]);
    if (!user || !(await checkAndUpgrade(user.id, String(password || ''), user.password_hash))) throw new ProviderError('Wrong username or password.', 401);
    await startSession(request, reply, user.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.sessionHash) await q('delete from sessions where token_hash = $1', [request.sessionHash]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/sessions', async request => {
    const rows = await q('select token_hash, user_agent, created_at, last_seen from sessions where user_id = $1 order by last_seen desc', [request.userId]);
    return rows.map(r => ({
      id: r.token_hash.slice(0, 16), device: describeAgent(r.user_agent), createdAt: r.created_at, lastSeen: r.last_seen,
      current: r.token_hash === request.sessionHash,
    }));
  });

  app.delete('/api/auth/sessions/:id', async request => {
    const { id } = request.params as { id: string };
    await q(`delete from sessions where user_id = $1 and left(token_hash, 16) = $2`, [request.userId, id]);
    return { ok: true };
  });

  app.post('/api/auth/password', async request => {
    const { current, next } = (request.body || {}) as { current?: string; next?: string };
    const user = await one<{ password_hash: string }>('select password_hash from users where id = $1', [request.userId]);
    if (!user || !(await verifyPassword(String(current || ''), user.password_hash))) throw new ProviderError('Current password is wrong.', 400);
    if (!validPassword(next)) throw new ProviderError('New password must be at least 8 characters.', 400);
    await q('update users set password_hash = $2 where id = $1', [request.userId, await hashPassword(String(next))]);
    // Other devices must sign in again with the new password; this one stays signed in.
    await revokeSessions(request.userId!, request.sessionHash);
    return { ok: true };
  });
}
