import type { FastifyInstance } from 'fastify';
import { one, q } from '../db.js';
import { ProviderError } from '../providers/types.js';

/*
 * Ownership checks. Every piece of content belongs to a workspace, and every workspace to one user.
 * Anything not owned by the caller is reported as "not found", never "forbidden".
 */

const notFound = (what: string): never => { throw new ProviderError(`${what} not found.`, 404); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ownWorkspace(userId: string | undefined, workspaceId: unknown) {
  if (!userId || typeof workspaceId !== 'string' || !UUID.test(workspaceId)) notFound('Workspace');
  const row = await one('select * from workspaces where id = $1 and user_id = $2', [workspaceId, userId]);
  return row || notFound('Workspace');
}

type Owned = 'folders' | 'refs' | 'elements' | 'generations' | 'assets';
const LABEL: Record<Owned, string> = { folders: 'Folder', refs: 'Reference', elements: 'Element', generations: 'Generation', assets: 'Result' };

/** Load a row the caller owns (through its workspace), or 404. */
export async function ownRow(userId: string | undefined, table: Owned, id: unknown) {
  if (!userId || typeof id !== 'string' || !UUID.test(id)) notFound(LABEL[table]);
  const row = await one(
    `select t.* from ${table} t join workspaces w on w.id = t.workspace_id where t.id = $1 and w.user_id = $2`, [id, userId]);
  return row || notFound(LABEL[table]);
}

/** Keep only the ids the caller owns. */
export async function ownedIds(userId: string | undefined, table: Owned, ids: string[]): Promise<string[]> {
  if (!userId || !ids.length) return [];
  const rows = await q<{ id: string }>(
    `select t.id from ${table} t join workspaces w on w.id = t.workspace_id where t.id = any($1::uuid[]) and w.user_id = $2`, [ids, userId]);
  return rows.map(r => r.id);
}

/** SQL fragment restricting `alias.workspace_id` to the caller's workspaces (uses the given param number). */
export const ownedWorkspaceSql = (alias: string, param: number) => `${alias}.workspace_id in (select id from workspaces where user_id = $${param})`;

// Media files are content-addressed; a user may only fetch files used by their own refs/results.
const mediaCache = new Map<string, number>(); // `${userId}:${path}` → expiry
const MEDIA_TTL = 10 * 60_000;

export function registerMediaGuard(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/media/') || !request.userId) return;
    const rel = decodeURIComponent(request.url.slice('/media/'.length).split('?')[0]);
    const key = `${request.userId}:${rel}`;
    if ((mediaCache.get(key) ?? 0) > Date.now()) return;
    const owned = await one(
      `select 1 from refs r join workspaces w on w.id = r.workspace_id where (r.file = $1 or r.thumb = $1) and w.user_id = $2
       union all
       select 1 from assets a join workspaces w on w.id = a.workspace_id where (a.file = $1 or a.thumb = $1) and w.user_id = $2
       limit 1`, [rel, request.userId]);
    if (!owned) return reply.code(404).send({ error: 'Not found' });
    if (mediaCache.size > 50_000) mediaCache.clear();
    mediaCache.set(key, Date.now() + MEDIA_TTL);
  });
}
