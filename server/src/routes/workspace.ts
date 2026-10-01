import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, q, tx } from '../db.js';
import { ProviderError } from '../providers/types.js';
import { ownedIds, ownRow, ownWorkspace } from '../services/access.js';
import { sanitizeRelativeDir } from '../services/exports.js';
import { collectGarbage, mimeFromName, storeStream } from '../services/media.js';
import { decodeCursor, encodeCursor, refDto, workspaceDto } from './dto.js';

const bad = (message: string, status = 400): never => { throw new ProviderError(message, status); };
const cleanName = (value: unknown, max = 80) => String(value ?? '').replace(/[\x00-\x1f]/g, '').trim().slice(0, max);
const ELEMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

const uid = (request: FastifyRequest) => request.userId!;

/** Create a user's workspace (also used for a new user's first workspace). */
export async function createWorkspace(userId: string, name: string, imageDir?: string, videoDir?: string) {
  const base = folderSlug(name);
  return one(
    'insert into workspaces (user_id, name, image_export_dir, video_export_dir) values ($1, $2, $3, $4) returning *',
    [userId, name, sanitizeRelativeDir(imageDir || `${base}/images`), sanitizeRelativeDir(videoDir || `${base}/videos`)]);
}

const cover = (a: { thumb?: string; file?: string; kind?: string }) =>
  a.thumb ? `/media/${a.thumb}` : a.kind === 'image' && a.file ? `/media/${a.file}` : null;

function folderSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
}

async function elementsFor(workspaceId: string) {
  const rows = await q(
    `select e.id, e.name, e.description, e.created_at,
            coalesce(json_agg(json_build_object('id', r.id, 'workspace_id', r.workspace_id, 'kind', r.kind, 'name', r.name, 'file', r.file,
              'thumb', r.thumb, 'mime', r.mime, 'width', r.width, 'height', r.height, 'is_model_ref', r.is_model_ref, 'created_at', r.created_at)
              order by er.position) filter (where r.id is not null), '[]') as refs
       from elements e left join element_refs er on er.element_id = e.id left join refs r on r.id = er.ref_id
      where e.workspace_id = $1 group by e.id order by lower(e.name)`, [workspaceId]);
  return rows.map(e => ({ id: e.id, name: e.name, description: e.description, createdAt: e.created_at, refs: e.refs.map(refDto) }));
}

export function workspaceRoutes(app: FastifyInstance) {
  // ---------- workspaces ----------
  app.get('/api/workspaces', async request =>
    (await q('select * from workspaces where user_id = $1 order by created_at', [uid(request)])).map(workspaceDto));

  app.post('/api/workspaces', async request => {
    const body = (request.body || {}) as any;
    const name = cleanName(body.name) || bad('Name the workspace.');
    return workspaceDto(await createWorkspace(uid(request), name, body.imageExportDir, body.videoExportDir));
  });

  app.patch('/api/workspaces/:id', async request => {
    const { id } = request.params as { id: string };
    const current = await ownWorkspace(uid(request), id);
    const body = (request.body || {}) as any;
    const name = body.name !== undefined ? cleanName(body.name) || bad('Name the workspace.') : current.name;
    const imageDir = body.imageExportDir !== undefined ? sanitizeRelativeDir(body.imageExportDir) : current.image_export_dir;
    const videoDir = body.videoExportDir !== undefined ? sanitizeRelativeDir(body.videoExportDir) : current.video_export_dir;
    const prefs = body.prefs && typeof body.prefs === 'object' ? { ...current.prefs, ...body.prefs } : current.prefs;
    const row = await one(
      'update workspaces set name = $2, image_export_dir = $3, video_export_dir = $4, prefs = $5 where id = $1 returning *',
      [id, name, imageDir, videoDir, JSON.stringify(prefs)]);
    return workspaceDto(row);
  });

  app.delete('/api/workspaces/:id', async request => {
    const { id } = request.params as { id: string };
    await ownWorkspace(uid(request), id);
    const [{ count }] = await q<{ count: number }>('select count(*) as count from workspaces where user_id = $1', [uid(request)]);
    if (count <= 1) bad('Keep at least one workspace.');
    const files = (await q<{ file: string }>('select file from refs where workspace_id = $1 union select file from assets where workspace_id = $1', [id])).map(r => r.file);
    await q('delete from workspaces where id = $1', [id]);
    collectGarbage(files).catch(() => {});
    return { ok: true };
  });

  // ---------- folders ----------
  app.get('/api/workspaces/:id/folders', async request => {
    const { id } = request.params as { id: string };
    await ownWorkspace(uid(request), id);
    const folders = await q(
      `select f.id, f.name, f.created_at, f.last_used_at, s.count, s.updated_at, c.thumb, c.file, c.kind
         from folders f
         left join lateral (select count(*) as count, max(created_at) as updated_at from assets where folder_id = f.id) s on true
         left join lateral (select thumb, file, kind from assets where folder_id = f.id order by created_at desc limit 1) c on true
        where f.workspace_id = $1 order by coalesce(s.updated_at, f.created_at) desc`, [id]);
    const unsorted = await one(
      `select count(*) as count, max(created_at) as updated_at,
              (select json_build_object('thumb', thumb, 'file', file, 'kind', kind) from assets
                where workspace_id = $1 and folder_id is null order by created_at desc limit 1) as latest
         from assets where workspace_id = $1 and folder_id is null`, [id]);
    return {
      folders: folders.map(f => ({
        id: f.id, name: f.name, count: f.count || 0, updatedAt: f.updated_at || f.created_at, lastUsedAt: f.last_used_at,
        coverUrl: cover(f),
      })),
      unsorted: { count: unsorted?.count || 0, updatedAt: unsorted?.updated_at, coverUrl: unsorted?.latest ? cover(unsorted.latest) : null },
    };
  });

  app.post('/api/folders', async request => {
    const body = (request.body || {}) as any;
    await ownWorkspace(uid(request), body.workspaceId);
    const name = cleanName(body.name, 60) || bad('Name the folder.');
    const existing = await one('select * from folders where workspace_id = $1 and lower(name) = lower($2)', [body.workspaceId, name]);
    if (existing) return { id: existing.id, name: existing.name };
    const row = await one('insert into folders (workspace_id, name) values ($1, $2) returning *', [body.workspaceId, name]);
    return { id: row.id, name: row.name };
  });

  app.patch('/api/folders/:id', async request => {
    const { id } = request.params as { id: string };
    const name = cleanName((request.body as any)?.name, 60) || bad('Name the folder.');
    await ownRow(uid(request), 'folders', id);
    try {
      const row = await one('update folders set name = $2 where id = $1 returning *', [id, name]);
      if (!row) bad('Folder not found.', 404);
      return { id: row.id, name: row.name };
    } catch (error: any) {
      if (error.code === '23505') bad('Another folder already has that name.');
      throw error;
    }
  });

  // Contents move to Unsorted (FK on delete set null).
  app.delete('/api/folders/:id', async request => {
    const { id } = request.params as { id: string };
    await ownRow(uid(request), 'folders', id);
    await q('delete from folders where id = $1', [id]);
    return { ok: true };
  });

  // ---------- references ----------
  app.get('/api/refs', async request => {
    const { workspaceId, tab, kind, cursor, limit } = request.query as Record<string, string | undefined>;
    await ownWorkspace(uid(request), workspaceId);
    const params: unknown[] = [workspaceId];
    let where = 'workspace_id = $1';
    if (tab === 'model') where += ' and is_model_ref';
    else if (tab === 'uploads') where += ' and not is_model_ref and source_asset_id is null';
    if (kind) { params.push(kind); where += ` and kind = $${params.length}`; }
    const c = decodeCursor(cursor);
    if (c) { params.push(c[0], c[1]); where += ` and (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`; }
    const size = Math.min(Number(limit) || 60, 200);
    const rows = await q(`select *, created_at::text as ts from refs where ${where} order by created_at desc, id desc limit ${size + 1}`, params);
    const more = rows.length > size;
    const items = rows.slice(0, size);
    return { items: items.map(refDto), nextCursor: more ? encodeCursor(items[items.length - 1].ts, items[items.length - 1].id) : null };
  });

  // All ids matching a Library tab, for "Select all" (items beyond the loaded page included).
  app.get('/api/refs/ids', async request => {
    const { workspaceId, tab, kind } = request.query as Record<string, string | undefined>;
    await ownWorkspace(uid(request), workspaceId);
    const params: unknown[] = [workspaceId];
    let where = 'workspace_id = $1';
    if (tab === 'model') where += ' and is_model_ref';
    else if (tab === 'uploads') where += ' and not is_model_ref and source_asset_id is null';
    if (kind) { params.push(kind); where += ` and kind = $${params.length}`; }
    return (await q<{ id: string }>(`select id from refs where ${where} order by created_at desc, id desc limit 10000`, params)).map(r => r.id);
  });

  app.post('/api/refs/bulk', async request => {
    const { ids, action } = (request.body || {}) as { ids?: string[]; action?: string };
    const list = await ownedIds(uid(request), 'refs', (ids || []).map(String).filter(id => /^[0-9a-f-]{36}$/.test(id)));
    if (!list.length) bad('Select something first.');
    if (action === 'delete') {
      const removed = await q<{ file: string }>('delete from refs where id = any($1::uuid[]) returning file', [list]);
      collectGarbage(removed.map(r => r.file)).catch(() => {});
      return { count: removed.length };
    }
    if (action === 'model' || action === 'unmodel') {
      const updated = await q('update refs set is_model_ref = $2 where id = any($1::uuid[]) returning id', [list, action === 'model']);
      return { count: updated.length };
    }
    bad('Unknown action.');
  });

  app.post('/api/refs/upload', async request => {
    const { workspaceId, modelRef } = request.query as Record<string, string | undefined>;
    await ownWorkspace(uid(request), workspaceId);
    const created = [];
    for await (const part of request.files()) {
      const mime = (part.mimetype && part.mimetype !== 'application/octet-stream' ? part.mimetype : mimeFromName(part.filename)) || '';
      const stored = await storeStream(part.file, mime);
      if (part.file.truncated) bad('File is too large.', 413);
      const name = cleanName(part.filename.replace(/\.[^.]+$/, ''), 80) || 'Reference';
      const row = await one(
        `insert into refs (workspace_id, kind, name, file, thumb, mime, width, height, is_model_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [workspaceId, stored.kind, name, stored.file, stored.thumb, stored.mime, stored.width, stored.height, modelRef === '1']);
      created.push(refDto(row));
    }
    if (!created.length) bad('Choose a file to upload.');
    return created;
  });

  /** Reference for a generated result (reused if one exists). `modelRef` also files it under Model refs. */
  async function refFromAsset(userId: string, assetId: string, modelRef: boolean) {
    await ownRow(userId, 'assets', assetId);
    const asset = await one(
      `select a.*, g.model_name from assets a join generations g on g.id = a.generation_id where a.id = $1`, [assetId]);
    if (!asset) bad('Result not found.', 404);
    const existing = await one('select * from refs where source_asset_id = $1', [assetId]);
    if (existing) {
      if (modelRef && !existing.is_model_ref) return one('update refs set is_model_ref = true where id = $1 returning *', [existing.id]);
      return existing;
    }
    const name = `${asset.model_name} ${new Date(asset.created_at).toISOString().slice(0, 10)}`;
    return one(
      `insert into refs (workspace_id, kind, name, file, thumb, mime, width, height, source_asset_id, is_model_ref)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [asset.workspace_id, asset.kind, name, asset.file, asset.thumb, asset.mime, asset.width, asset.height, asset.id, modelRef]);
  }

  app.post('/api/refs/from-asset', async request => {
    const { assetId, modelRef } = (request.body || {}) as { assetId?: string; modelRef?: boolean };
    return refDto(await refFromAsset(uid(request), String(assetId), modelRef === true));
  });

  // Several results at once (e.g. "Add from generated" into Model refs).
  app.post('/api/refs/from-assets', async request => {
    const { assetIds, modelRef } = (request.body || {}) as { assetIds?: string[]; modelRef?: boolean };
    const ids = (assetIds || []).map(String).filter(id => /^[0-9a-f-]{36}$/.test(id));
    if (!ids.length) bad('Select something first.');
    const refs = [];
    for (const id of ids) refs.push(refDto(await refFromAsset(uid(request), id, modelRef === true)));
    return refs;
  });

  app.get('/api/refs/by-ids', async request => {
    const { ids } = request.query as { ids?: string };
    const list = await ownedIds(uid(request), 'refs', String(ids || '').split(',').filter(id => /^[0-9a-f-]{36}$/.test(id)));
    if (!list.length) return [];
    return (await q('select * from refs where id = any($1::uuid[])', [list])).map(refDto);
  });

  app.patch('/api/refs/:id', async request => {
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as any;
    const current = await ownRow(uid(request), 'refs', id);
    const name = body.name !== undefined ? cleanName(body.name) || bad('Name the reference.') : current.name;
    const isModelRef = typeof body.isModelRef === 'boolean' ? body.isModelRef : current.is_model_ref;
    return refDto(await one('update refs set name = $2, is_model_ref = $3 where id = $1 returning *', [id, name, isModelRef]));
  });

  app.delete('/api/refs/:id', async request => {
    const { id } = request.params as { id: string };
    await ownRow(uid(request), 'refs', id);
    const row = await one<{ file: string }>('delete from refs where id = $1 returning file', [id]);
    if (row) collectGarbage([row.file]).catch(() => {});
    return { ok: true };
  });

  // ---------- elements ----------
  app.get('/api/elements', async request => {
    const { workspaceId } = request.query as { workspaceId?: string };
    await ownWorkspace(uid(request), workspaceId);
    return elementsFor(String(workspaceId));
  });

  async function saveElement(workspaceId: string, id: string | null, body: any) {
    const name = String(body.name ?? '').trim();
    if (!ELEMENT_NAME.test(name)) bad('Element names start with a letter and use letters, numbers, - or _ (no spaces).');
    if (/^(image|img|ref)\d+$/i.test(name)) bad('That name is reserved for numbered references.');
    const description = String(body.description ?? '').trim().slice(0, 500);
    const refIds: string[] = [...new Set<string>((body.refIds || []).map(String))];
    if (!refIds.length) bad('Pick at least one reference for the element.');
    const valid = await q('select id from refs where workspace_id = $1 and id = any($2::uuid[])', [workspaceId, refIds]);
    if (valid.length !== refIds.length) bad('Some references are not in this workspace.');
    try {
      return await tx(async client => {
        const { rows } = id
          ? await client.query('update elements set name = $2, description = $3 where id = $1 returning id', [id, name, description])
          : await client.query('insert into elements (workspace_id, name, description) values ($1, $2, $3) returning id', [workspaceId, name, description]);
        const elementId = rows[0].id;
        await client.query('delete from element_refs where element_id = $1', [elementId]);
        for (const [position, refId] of refIds.entries()) {
          await client.query('insert into element_refs (element_id, ref_id, position) values ($1,$2,$3)', [elementId, refId, position]);
        }
        return elementId;
      });
    } catch (error: any) {
      if (error.code === '23505') bad(`@${name} already exists in this workspace.`);
      throw error;
    }
  }

  app.post('/api/elements', async request => {
    const body = (request.body || {}) as any;
    await ownWorkspace(uid(request), body.workspaceId);
    await saveElement(body.workspaceId, null, body);
    return elementsFor(body.workspaceId);
  });

  app.patch('/api/elements/:id', async request => {
    const { id } = request.params as { id: string };
    const element = await ownRow(uid(request), 'elements', id);
    await saveElement(element.workspace_id, id, request.body || {});
    return elementsFor(element.workspace_id);
  });

  app.delete('/api/elements/:id', async request => {
    const { id } = request.params as { id: string };
    await ownRow(uid(request), 'elements', id);
    await q('delete from elements where id = $1', [id]);
    return { ok: true };
  });
}
