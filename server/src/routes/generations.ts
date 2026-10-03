import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { one, q } from '../db.js';
import { ProviderError } from '../providers/types.js';
import { ownedIds, ownRow, ownWorkspace } from '../services/access.js';
import { slug } from '../services/exports.js';
import { ACTIVE, createGenerations, type GenerateInput } from '../services/generations.js';
import { deleteAssets, moveAssets, saveAsset } from '../services/assets.js';
import { collectGarbage } from '../services/media.js';
import { deleteSaved, type SavedEntry } from '../services/saveTargets.js';
import { trimAsset } from '../services/trim.js';
import { mediaDir } from '../config.js';
import { assetDto, decodeCursor, encodeCursor, generationDto, refDto } from './dto.js';

const bad = (message: string, status = 400): never => { throw new ProviderError(message, status); };
const UUIDS = (value: unknown) => (Array.isArray(value) ? value : []).map(String).filter(id => /^[0-9a-f-]{36}$/.test(id));
const uid = (request: FastifyRequest) => request.userId!;

export function generationRoutes(app: FastifyInstance) {
  app.post('/api/generations', async request => (await createGenerations(uid(request), request.body as GenerateInput)).map(generationDto));

  // In-progress jobs plus recent failures (shown as cards until dismissed).
  app.get('/api/generations/active', async request => {
    const { workspaceId } = request.query as { workspaceId?: string };
    await ownWorkspace(uid(request), workspaceId);
    const rows = await q(
      `select * from generations where workspace_id = $1
         and (status = any($2) or (status = 'failed' and created_at > now() - interval '3 days'))
       order by created_at desc limit 50`, [workspaceId, ACTIVE]);
    return rows.map(generationDto);
  });

  // Latest generation of a kind in a workspace (e.g. to reuse the last video settings for "Animate").
  app.get('/api/generations/last', async request => {
    const { workspaceId, modality } = request.query as { workspaceId?: string; modality?: string };
    if (modality !== 'image' && modality !== 'video') bad('Choose image or video.');
    await ownWorkspace(uid(request), workspaceId);
    const g = await one(
      `select * from generations where workspace_id = $1 and modality = $2 and provider_id <> 'upload'
        order by (status = 'succeeded') desc, created_at desc limit 1`, [workspaceId, modality]);
    return g ? generationDto(g) : null;
  });

  app.get('/api/generations/:id', async request => {
    const { id } = request.params as { id: string };
    const g = await ownRow(uid(request), 'generations', id);
    const refIds = Object.values<string[]>(g.ref_slots || {}).flat();
    const refs = refIds.length ? await q('select * from refs where id = any($1::uuid[]) and workspace_id = $2', [refIds, g.workspace_id]) : [];
    const assets = await q(
      `select a.*, g.prompt, g.model_name, g.provider_id, g.model_id from assets a join generations g on g.id = a.generation_id
        where a.generation_id = $1 order by a.idx`, [id]);
    const folder = g.folder_id ? await one('select id, name from folders where id = $1', [g.folder_id]) : null;
    // Made by an agent (API token); the name is gone if the key was deleted since.
    const agent = g.api_token_id ? await one<{ name: string }>('select name from api_tokens where id = $1', [g.api_token_id]) : null;
    // Auto-routed: report what was picked in the create box (for Recreate/Animate) and what actually ran.
    const auto = g.resolved_input?.auto;
    const dto = generationDto(g);
    return {
      ...dto,
      ...(auto ? {
        modelId: auto.modelId, settings: auto.settings, refSlots: auto.refSlots,
        routed: { modelId: dto.modelId, modelName: dto.modelName, settings: dto.settings, refSlots: dto.refSlots },
      } : {}),
      resolvedPrompt: g.resolved_input?.prompt,
      ...(g.resolved_input?.original ? { originalPrompt: g.resolved_input.original } : {}),
      refs: refs.map(refDto),
      assets: assets.map(assetDto),
      folder,
      ...(g.api_token_id ? { agentName: agent?.name || 'a deleted agent key' } : {}),
    };
  });

  // Resubmit a failed generation with exactly the same inputs, replacing the failed card.
  app.post('/api/generations/:id/retry', async request => {
    const { id } = request.params as { id: string };
    const g = await ownRow(uid(request), 'generations', id);
    if (g.status !== 'failed') bad('Only failed generations can be retried.');
    const rows = await createGenerations(uid(request), {
      workspaceId: g.workspace_id, modelId: `${g.provider_id}:${g.model_id}`, prompt: g.prompt,
      settings: g.settings, refSlots: g.ref_slots, folderId: g.folder_id, batch: 1,
    });
    await q('delete from generations where id = $1', [id]);
    return rows.map(generationDto);
  });

  app.delete('/api/generations/:id', async request => {
    const { id } = request.params as { id: string };
    await ownRow(uid(request), 'generations', id);
    const files = (await q<{ file: string }>('select file from assets where generation_id = $1', [id])).map(r => r.file);
    await q('delete from generations where id = $1', [id]);
    collectGarbage(files).catch(() => {});
    return { ok: true };
  });

  app.get('/api/assets', async request => {
    const { workspaceId, folder, kind, cursor, limit } = request.query as Record<string, string | undefined>;
    await ownWorkspace(uid(request), workspaceId);
    const params: unknown[] = [workspaceId];
    let where = 'a.workspace_id = $1';
    if (folder === 'unsorted') where += ' and a.folder_id is null';
    else if (folder && folder !== 'all') { params.push(folder); where += ` and a.folder_id = $${params.length}`; }
    if (kind === 'image' || kind === 'video') { params.push(kind); where += ` and a.kind = $${params.length}`; }
    const c = decodeCursor(cursor);
    if (c) { params.push(c[0], c[1]); where += ` and (a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`; }
    const size = Math.min(Number(limit) || 60, 200);
    const rows = await q(
      `select a.*, a.created_at::text as ts, g.prompt, g.model_name, g.provider_id, g.model_id
         from assets a join generations g on g.id = a.generation_id
        where ${where} order by a.created_at desc, a.id desc limit ${size + 1}`, params);
    const more = rows.length > size;
    const items = rows.slice(0, size);
    return { items: items.map(assetDto), nextCursor: more ? encodeCursor(items[items.length - 1].ts, items[items.length - 1].id) : null };
  });

  // All ids for the current grid view, for "Select all" (not just the loaded pages).
  app.get('/api/assets/ids', async request => {
    const { workspaceId, folder, kind } = request.query as Record<string, string | undefined>;
    await ownWorkspace(uid(request), workspaceId);
    const params: unknown[] = [workspaceId];
    let where = 'workspace_id = $1';
    if (folder === 'unsorted') where += ' and folder_id is null';
    else if (folder && folder !== 'all') { params.push(folder); where += ` and folder_id = $${params.length}`; }
    if (kind === 'image' || kind === 'video') { params.push(kind); where += ` and kind = $${params.length}`; }
    return (await q<{ id: string }>(`select id from assets where ${where} order by created_at desc, id desc limit 20000`, params)).map(r => r.id);
  });

  // Mark results as seen (opened in the viewer). Only the first view is recorded.
  app.post('/api/assets/seen', async request => {
    const ids = await ownedIds(uid(request), 'assets', UUIDS((request.body as any)?.assetIds));
    if (!ids.length) return { updated: 0 };
    const rows = await q('update assets set seen_at = now() where id = any($1::uuid[]) and seen_at is null returning id', [ids]);
    return { updated: rows.length };
  });

  app.post('/api/assets/move', async request => {
    const body = (request.body || {}) as { assetIds?: string[]; folderId?: string | null };
    return { moved: await moveAssets(uid(request), UUIDS(body.assetIds), body.folderId || null) };
  });

  app.post('/api/assets/delete', async request => ({ deleted: await deleteAssets(uid(request), UUIDS((request.body as any)?.assetIds)) }));

  // Trim a video into a new result next to the original (the original stays).
  app.post('/api/assets/:id/trim', async request => {
    const { start, end } = (request.body || {}) as { start?: number; end?: number };
    const row = await trimAsset(uid(request), (request.params as { id: string }).id, start, end);
    const full = await one(
      `select a.*, g.prompt, g.model_name, g.provider_id, g.model_id from assets a join generations g on g.id = a.generation_id where a.id = $1`, [row.id]);
    return assetDto(full);
  });

  // "Save": copy a result to the user's save location (server folder or SMB share).
  app.post('/api/assets/:id/export', async request => ({ path: await saveAsset(uid(request), (request.params as { id: string }).id) }));

  // "Unsave": remove the copies Save made (only those; the result itself stays).
  app.delete('/api/assets/:id/export', async request => {
    const { id } = request.params as { id: string };
    const a = await ownRow(uid(request), 'assets', id);
    const entries: SavedEntry[] = a.exported_paths || [];
    const kept: SavedEntry[] = [];
    let error: unknown;
    for (const entry of entries) {
      try { await deleteSaved(uid(request), entry); }
      catch (e) { kept.push(entry); error ||= e; }
    }
    await q(`update assets set exported_paths = $2::jsonb where id = $1`, [id, JSON.stringify(kept)]);
    if (error) throw error;
    return { removed: entries.length };
  });

  app.get('/api/assets/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    await ownRow(uid(request), 'assets', id);
    const a = await one('select a.*, g.model_name from assets a join generations g on g.id = a.generation_id where a.id = $1', [id]);
    const ext = path.extname(a.file);
    const name = `${slug(a.model_name)}_${new Date(a.created_at).toISOString().slice(0, 19).replace(/[-:T]/g, '')}_${a.idx + 1}${ext}`;
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.sendFile(a.file, mediaDir(), { cacheControl: false });
  });
}
