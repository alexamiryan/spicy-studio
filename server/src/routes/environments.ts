import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, q } from '../db.js';
import { ProviderError } from '../providers/types.js';
import { ownedIds, ownWorkspace } from '../services/access.js';
import { collectGarbage, mimeFromName, storeStream } from '../services/media.js';
import { decodeCursor, encodeCursor, environmentDto, refDto } from './dto.js';
import { environmentFor } from './workspace.js';

const bad = (message: string, status = 400): never => { throw new ProviderError(message, status); };
const cleanName = (value: unknown, max = 80) => String(value ?? '').replace(/[\x00-\x1f]/g, '').trim().slice(0, max);
const uid = (request: FastifyRequest) => request.userId!;
const UUID = /^[0-9a-f-]{36}$/;

/**
 * The environment library: real-location photos a user uploads once and uses as references in any of
 * their workspaces. Using one creates (or reuses) a workspace reference linked to it, so generations,
 * recreate and the generation details work exactly as with any other reference.
 */
/**
 * The workspace reference for an environment photo (generations only use workspace refs): the one made
 * earlier, or a new one linked to it. The workspace must already be checked.
 */
export async function useEnvironment(userId: string, workspaceId: string, id: string) {
  const env = await one('select * from environments where id = $1 and user_id = $2', [id, userId]);
  if (!env) bad('Environment not found.', 404);
  const existing = await one('select * from refs where workspace_id = $1 and source_environment_id = $2 order by created_at limit 1', [workspaceId, id]);
  return existing || one(
    `insert into refs (workspace_id, kind, name, file, thumb, mime, width, height, source_environment_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [workspaceId, env.kind, env.name, env.file, env.thumb, env.mime, env.width, env.height, env.id]);
}

export function environmentRoutes(app: FastifyInstance) {
  app.get('/api/environments', async request => {
    const { cursor, limit } = request.query as Record<string, string | undefined>;
    const params: unknown[] = [uid(request)];
    let where = 'user_id = $1';
    const c = decodeCursor(cursor);
    if (c) { params.push(c[0], c[1]); where += ` and (created_at, id) < ($2::timestamptz, $3::uuid)`; }
    const size = Math.min(Number(limit) || 60, 200);
    const rows = await q(`select *, created_at::text as ts from environments where ${where} order by created_at desc, id desc limit ${size + 1}`, params);
    const more = rows.length > size;
    const items = rows.slice(0, size);
    return { items: items.map(environmentDto), nextCursor: more ? encodeCursor(items[items.length - 1].ts, items[items.length - 1].id) : null };
  });

  app.get('/api/environments/ids', async request =>
    (await q<{ id: string }>('select id from environments where user_id = $1 order by created_at desc, id desc limit 10000', [uid(request)])).map(r => r.id));

  app.post('/api/environments/upload', async request => {
    const created = [];
    for await (const part of request.files()) {
      const mime = (part.mimetype && part.mimetype !== 'application/octet-stream' ? part.mimetype : mimeFromName(part.filename)) || '';
      if (!mime.startsWith('image/')) bad('The environment library takes photos only.');
      const stored = await storeStream(part.file, mime);
      if (part.file.truncated) bad('File is too large.', 413);
      if (!stored.width || !stored.height) {
        collectGarbage([stored.file]).catch(() => {});
        bad(`${part.filename} is not a photo that can be read.`);
      }
      const name = cleanName(part.filename.replace(/\.[^.]+$/, ''), 80) || 'Environment';
      // The same photo uploaded again (e.g. retrying a big selection) is not added twice.
      created.push(environmentDto(await environmentFor(uid(request), { ...stored, name })));
    }
    if (!created.length) bad('Choose a photo to upload.');
    return created;
  });

  app.patch('/api/environments/:id', async request => {
    const { id } = request.params as { id: string };
    const name = cleanName((request.body as any)?.name);
    if (!name) bad('Give it a name.');
    const row = await one('update environments set name = $3 where id = $1 and user_id = $2 returning *', [id, uid(request), name]);
    if (!row) bad('Environment not found.', 404);
    return environmentDto(row);
  });

  app.post('/api/environments/delete', async request => {
    const ids = ((request.body as any)?.ids || []).map(String).filter((id: string) => UUID.test(id));
    if (!ids.length) bad('Select something first.');
    // References already made from these photos stay in their workspaces (hidden, still linked) and keep their files.
    const removed = await q<{ file: string }>('delete from environments where user_id = $1 and id = any($2::uuid[]) returning file', [uid(request), ids]);
    collectGarbage(removed.map(r => r.file)).catch(() => {});
    return { deleted: removed.length };
  });

  /** Move environments into a workspace's Model refs or Uploads (out of the shared library). */
  app.post('/api/environments/move', async request => {
    const { workspaceId, ids, to } = (request.body || {}) as { workspaceId?: string; ids?: string[]; to?: string };
    await ownWorkspace(uid(request), workspaceId);
    if (to !== 'model' && to !== 'uploads') bad('Choose Model refs or Uploads.');
    const wanted = (ids || []).map(String).filter(id => UUID.test(id));
    const envs = await q('select * from environments where user_id = $1 and id = any($2::uuid[])', [uid(request), wanted]);
    if (!envs.length) bad('Select something first.');
    for (const env of envs) {
      // Reuse this workspace's reference for it if there is one; other workspaces keep theirs (hidden).
      const existing = await one('select id from refs where workspace_id = $1 and source_environment_id = $2 order by created_at limit 1', [workspaceId, env.id]);
      if (existing) await q('update refs set source_environment_id = null, is_model_ref = $2 where id = $1', [existing.id, to === 'model']);
      else {
        await q(
          `insert into refs (workspace_id, kind, name, file, thumb, mime, width, height, is_model_ref) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [workspaceId, env.kind, env.name, env.file, env.thumb, env.mime, env.width, env.height, to === 'model']);
      }
    }
    await q('delete from environments where user_id = $1 and id = any($2::uuid[])', [uid(request), envs.map(e => e.id)]);
    return { count: envs.length };
  });

  /** Add generated photos to the environment library. */
  app.post('/api/environments/from-assets', async request => {
    const { assetIds } = (request.body || {}) as { assetIds?: string[] };
    const ids = await ownedIds(uid(request), 'assets', (assetIds || []).map(String).filter(id => UUID.test(id)));
    if (!ids.length) bad('Select something first.');
    const assets = await q(
      `select a.*, g.model_name from assets a join generations g on g.id = a.generation_id where a.id = any($1::uuid[]) and a.kind = 'image'`, [ids]);
    if (!assets.length) bad('Only photos can go into the environment library.');
    const created = [];
    for (const a of assets) {
      const name = `${a.model_name} ${new Date(a.created_at).toISOString().slice(0, 10)}`;
      created.push(environmentDto(await environmentFor(uid(request), { ...a, name })));
    }
    return created;
  });

  /** Turn environments into references of a workspace (reusing ones made before), in the given order. */
  app.post('/api/environments/use', async request => {
    const { workspaceId, ids } = (request.body || {}) as { workspaceId?: string; ids?: string[] };
    await ownWorkspace(uid(request), workspaceId);
    const wanted = (ids || []).map(String).filter(id => UUID.test(id));
    if (!wanted.length) bad('Select something first.');
    const refs = [];
    for (const id of wanted) refs.push(refDto(await useEnvironment(uid(request), workspaceId!, id)));
    return refs;
  });
}
