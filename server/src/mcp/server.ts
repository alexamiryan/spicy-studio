import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config, mediaDir } from '../config.js';
import { one } from '../db.js';
import { ProviderError } from '../providers/types.js';
import { allowsWorkspace, requirePerm } from '../services/apiTokens.js';
import { ownRow } from '../services/access.js';
import { slug } from '../services/exports.js';
import { absPath } from '../services/media.js';
import { stripImage, stripVideo } from '../services/metadata.js';
import { INSTRUCTIONS, TOOLS, type ToolContext } from './tools.js';

const origin = (request: FastifyRequest) =>
  config.publicUrl || `${request.protocol}://${request.headers['x-forwarded-host'] || request.headers.host}`;

/** One MCP server per request (stateless Streamable HTTP): nothing to keep in memory, survives restarts. */
function mcpServer(ctx: ToolContext) {
  const server = new Server({ name: 'spicy-studio', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.perm && !ctx.agent.perms.includes(t.perm) ? `${t.description} (Not allowed for this key.)` : t.description,
      inputSchema: { type: 'object' as const, properties: t.properties, ...(t.required ? { required: t.required } : {}) },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = TOOLS.find(t => t.name === request.params.name);
    try {
      if (!tool) throw new ProviderError(`Unknown tool ${request.params.name}.`, 404);
      if (tool.perm) requirePerm(ctx.agent, tool.perm);
      const result = await tool.run(ctx, (request.params.arguments || {}) as Record<string, any>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      // Provider/validation errors are written for people; anything else is logged and kept vague.
      const message = error instanceof ProviderError ? error.message : 'Something went wrong in the studio. Try again in a moment.';
      if (!(error instanceof ProviderError)) console.error(`[mcp] ${request.params.name} failed`, error);
      return { content: [{ type: 'text' as const, text: message }], isError: true };
    }
  });
  return server;
}

export function mcpRoutes(app: FastifyInstance) {
  // Base64 uploads make tool calls larger than ordinary API requests.
  const options = { bodyLimit: 80 * 1024 * 1024, config: { rateLimit: { max: 300, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => r.agent?.id || r.ip } } };

  app.post('/mcp', options, async (request, reply) => {
    const ctx: ToolContext = { userId: request.userId!, agent: request.agent!, origin: origin(request) };
    const server = mcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless: no server-initiated streams or sessions to end.
  const notAllowed = async (_request: FastifyRequest, reply: any) =>
    reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  /** A result file for agents: the original, or with metadata stripped (?clean=1). */
  app.get('/api/agent/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { clean } = request.query as { clean?: string };
    await ownRow(request.userId, 'assets', id);
    const a = await one('select a.*, g.model_name from assets a join generations g on g.id = a.generation_id where a.id = $1', [id]);
    if (!allowsWorkspace(request.agent!, a.workspace_id)) throw new ProviderError('Not found.', 404);
    const ext = path.extname(a.file);
    const name = `${slug(a.model_name)}_${new Date(a.created_at).toISOString().slice(0, 19).replace(/[-:T]/g, '')}_${a.idx + 1}${ext}`;
    reply.header('Content-Disposition', `attachment; filename="${name}"`).header('Cache-Control', 'no-store');
    if (clean !== '1') return reply.sendFile(a.file, mediaDir(), { cacheControl: false });
    if (a.kind === 'video') {
      // Stripped into a temporary copy, streamed, then removed.
      const target = path.join(os.tmpdir(), `clean-${randomUUID()}${ext}`);
      try { await stripVideo(absPath(a.file), target); } catch (error) { await rm(target, { force: true }); throw error; }
      const stream = createReadStream(target);
      stream.on('close', () => { rm(target, { force: true }).catch(() => {}); });
      return reply.type(a.mime).send(stream);
    }
    const original = await readFile(absPath(a.file));
    return reply.type(a.mime).send(stripImage(original, a.mime) || original);
  });
}
