import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { registerAuth, seedAdmin } from './auth.js';
import { registerEvents } from './events.js';
import { config, mediaDir } from './config.js';
import { migrate, one, q, waitForDb } from './db.js';
import { ProviderError } from './providers/types.js';
import { generationRoutes } from './routes/generations.js';
import { providerRoutes } from './routes/providers.js';
import { workspaceRoutes } from './routes/workspace.js';
import { adminRoutes } from './routes/admin.js';
import { environmentRoutes } from './routes/environments.js';
import { presetRoutes } from './routes/presets.js';
import { registerMediaGuard } from './services/access.js';
import { bootstrap } from './services/bootstrap.js';
import { startWorker } from './services/generations.js';
import { SAFE_MEDIA_PATH } from './services/media.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' }, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });

app.setErrorHandler((error: any, _request, reply) => {
  // Malformed ids reach uuid columns as Postgres "invalid input syntax" errors.
  if (error?.code === '22P02') return reply.code(400).send({ error: 'Invalid id.' });
  // A provider rejecting its API key is not this app's login expiring (401 makes the web app sign out).
  const status = error instanceof ProviderError ? (error.status === 401 ? 400 : error.status) : error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
  if (status >= 500) app.log.error(error);
  reply.code(status).send({ error: error.message || 'Unexpected error' });
});

// Accept empty JSON bodies (e.g. POST actions without parameters).
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
  if (!body) return done(null, {});
  try { done(null, JSON.parse(body as string)); }
  catch { done(new ProviderError('Invalid JSON body.', 400), undefined); }
});

await app.register(cookie);
await app.register(rateLimit, { global: false });
// The web app uploads a few files per request; the generous per-request cap is only a safety limit.
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 500 } });
// Before any route (incl. static media) so every protected path goes through the session check.
registerAuth(app);
// Media files are only served to the user who owns them.
registerMediaGuard(app);

await mkdir(mediaDir(), { recursive: true });
await mkdir(config.exportRoot, { recursive: true });

// Web app (built SPA). decorateReply gives us reply.sendFile for downloads too.
const hasWeb = existsSync(path.join(config.webDist, 'index.html'));
await app.register(fastifyStatic, { root: hasWeb ? config.webDist : mediaDir(), prefix: '/', wildcard: false, serve: hasWeb, index: false });

// Media is content-addressed, so it can be cached forever. Range requests work (needed for iOS video).
await app.register(fastifyStatic, {
  root: mediaDir(), prefix: '/media/', decorateReply: false, maxAge: '365d', immutable: true,
  allowedPath: pathName => SAFE_MEDIA_PATH.test(pathName.replace(/^\//, '')),
});

registerEvents(app);
providerRoutes(app);
adminRoutes(app);
workspaceRoutes(app);
environmentRoutes(app);
presetRoutes(app);
generationRoutes(app);

app.get('/healthz', async () => ({ ok: true }));
app.get('/api/config', async () => ({ exportRoot: config.exportRootLabel }));

// The web build this server serves: the hashed name of its main script. Open apps compare it with the
// script they are running and offer a refresh when it differs (installed PWAs never reload by themselves).
const webVersion = hasWeb
  ? /\/assets\/[\w.-]+\.js/.exec(readFileSync(path.join(config.webDist, 'index.html'), 'utf8'))?.[0] || null
  : null;
app.get('/api/version', async () => ({ web: webVersion }));

app.setNotFoundHandler((request, reply) => {
  if (request.method === 'GET' && hasWeb && !request.url.startsWith('/api/') && !request.url.startsWith('/media/')) {
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html', config.webDist);
  }
  reply.code(404).send({ error: 'Not found' });
});

await waitForDb();
await migrate();
await seedAdmin();
await bootstrap();
startWorker();

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Spicy Studio listening on http://localhost:${config.port}`);
