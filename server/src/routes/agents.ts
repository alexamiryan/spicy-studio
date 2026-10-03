import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { createToken, deleteToken, listTokens, PERMS, updateToken } from '../services/apiTokens.js';

const uid = (request: FastifyRequest) => request.userId!;
const origin = (request: FastifyRequest) =>
  config.publicUrl || `${request.protocol}://${request.headers['x-forwarded-host'] || request.headers.host}`;

/** Settings → Agents: API keys for MCP clients. Cookie sessions only (agent keys can't manage keys). */
export function agentRoutes(app: FastifyInstance) {
  app.get('/api/agents', async request => ({ agents: await listTokens(uid(request)), perms: PERMS, mcpUrl: `${origin(request)}/mcp` }));
  app.post('/api/agents', async request => createToken(uid(request), (request.body || {}) as any));
  app.patch('/api/agents/:id', async request => updateToken(uid(request), (request.params as { id: string }).id, (request.body || {}) as any));
  app.delete('/api/agents/:id', async request => {
    await deleteToken(uid(request), (request.params as { id: string }).id);
    return { ok: true };
  });
}
