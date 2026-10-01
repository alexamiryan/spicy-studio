import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';

/**
 * Live updates: every open tab keeps a Server-Sent Events connection and refreshes when anything
 * changes (a generation started on the phone, a job finishing in the worker, a move, a delete…).
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

const pending = new Map<string, NodeJS.Timeout>();
/** Signal that a user's data changed. Bursts are coalesced into one event per user. */
export function notifyChange(userId: string | undefined) {
  if (!userId || pending.has(userId)) return;
  pending.set(userId, setTimeout(() => { pending.delete(userId); bus.emit(`change:${userId}`); }, 150));
}

export function registerEvents(app: FastifyInstance) {
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const send = () => res.write(`event: change\ndata: ${Date.now()}\n\n`);
    // Comments keep proxies (Tailscale serve, phones on cellular) from closing an idle stream.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    const channel = `change:${request.userId}`;
    bus.on(channel, send);
    request.raw.on('close', () => { clearInterval(heartbeat); bus.off(channel, send); });
  });

  // Any successful change made through the API (from any device) is broadcast.
  app.addHook('onResponse', async (request, reply) => {
    const url = request.url;
    if (request.method === 'GET' || !url.startsWith('/api/') || url.startsWith('/api/auth/') || url.startsWith('/api/quote')) return;
    if (reply.statusCode < 400) notifyChange(request.userId);
  });
}
