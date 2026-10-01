import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, q } from '../db.js';
import { ProviderError } from '../providers/types.js';
import { ownWorkspace } from '../services/access.js';
import { collectGarbage, mimeFromName, storeStream } from '../services/media.js';
import { decodeCursor, encodeCursor, environmentDto, refDto } from './dto.js';

const bad = (message: string, status = 400): never => { throw new ProviderError(message, status); };
const cleanName = (value: unknown, max = 80) => String(value ?? '').replace(/[\x00-\x1f]/g, '').trim().slice(0, max);
const uid = (request: FastifyRequest) => request.userId!;
const UUID = /^[0-9a-f-]{36}$/;

/**
 * The environment library: real-location photos a user uploads once and uses as references in any of
 * their workspaces. Using one creates (or reuses) a workspace reference linked to it, so generations,
 * recreate and the generation details work exactly as with any other reference.
 */
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
      const row = await one(
        `insert into environments (user_id, kind, name, file, thumb, mime, width, height)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [uid(request), stored.kind, name, stored.file, stored.thumb, stored.mime, stored.width, stored.height]);
      created.push(environmentDto(row));
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
    // References already made from these photos stay in their workspaces (and keep their files).
    const removed = await q<{ file: string }>('delete from environments where user_id = $1 and id = any($2::uuid[]) returning file', [uid(request), ids]);
    collectGarbage(removed.map(r => r.file)).catch(() => {});
    return { deleted: removed.length };
  });

  /** Turn environments into references of a workspace (reusing ones made before), in the given order. */
  app.post('/api/environments/use', async request => {
    const { workspaceId, ids } = (request.body || {}) as { workspaceId?: string; ids?: string[] };
    await ownWorkspace(uid(request), workspaceId);
    const wanted = (ids || []).map(String).filter(id => UUID.test(id));
    if (!wanted.length) bad('Select something first.');
    const refs = [];
    for (const id of wanted) {
      const env = await one('select * from environments where id = $1 and user_id = $2', [id, uid(request)]);
      if (!env) bad('Environment not found.', 404);
      const existing = await one('select * from refs where workspace_id = $1 and source_environment_id = $2 order by created_at limit 1', [workspaceId, id]);
      refs.push(refDto(existing || await one(
        `insert into refs (workspace_id, kind, name, file, thumb, mime, width, height, source_environment_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [workspaceId, env.kind, env.name, env.file, env.thumb, env.mime, env.width, env.height, env.id])));
    }
    return refs;
  });
}
