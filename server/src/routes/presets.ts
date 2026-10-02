import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, q } from '../db.js';
import { ProviderError } from '../providers/types.js';
import { ownRow, ownWorkspace } from '../services/access.js';
import { refDto } from './dto.js';

const bad = (message: string, status = 400): never => { throw new ProviderError(message, status); };
const uid = (request: FastifyRequest) => request.userId!;
const UUID = /^[0-9a-f-]{36}$/;

interface PresetState { modelId?: string; prompt?: string; settings?: unknown; refSlots?: unknown; folderId?: string | null; batch?: number }

/** Validate a create-box state: references and folder must belong to the workspace. */
async function cleanState(workspaceId: string, body: PresetState) {
  const modelId = String(body.modelId || '');
  if (!modelId.includes(':')) bad('Pick a model first.');
  const settings = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings : {};
  const slots: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries((body.refSlots && typeof body.refSlots === 'object' ? body.refSlots : {}) as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    const list = [...new Set(ids.map(String).filter(id => UUID.test(id)))];
    const owned = list.length ? new Set((await q<{ id: string }>('select id from refs where workspace_id = $1 and id = any($2::uuid[])', [workspaceId, list])).map(r => r.id)) : new Set();
    slots[key.slice(0, 100)] = list.filter(id => owned.has(id));
  }
  let folderId = body.folderId && UUID.test(String(body.folderId)) ? String(body.folderId) : null;
  if (folderId && !(await one('select 1 from folders where id = $1 and workspace_id = $2', [folderId, workspaceId]))) folderId = null;
  const batch = Math.min(Math.max(Math.round(Number(body.batch) || 1), 1), 8);
  return { modelId, prompt: String(body.prompt || '').slice(0, 20000), settings, slots, folderId, batch };
}

const cleanName = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60);

async function presetDto(p: any) {
  const ids = Object.values<string[]>(p.ref_slots || {}).flat();
  const refs = ids.length ? (await q('select * from refs where id = any($1::uuid[])', [ids])).map(refDto) : [];
  return {
    id: p.id, workspaceId: p.workspace_id, modality: p.modality, name: p.name, modelId: p.model_id, prompt: p.prompt,
    settings: p.settings, refSlots: p.ref_slots, refs, folderId: p.folder_id, batch: p.batch,
    createdAt: p.created_at, updatedAt: p.updated_at, lastUsedAt: p.last_used_at,
  };
}

const taken = (error: any, name: string) => {
  if (error?.code === '23505') bad(`A preset called "${name}" already exists. Pick another name, or update that one.`);
  throw error;
};

/** Presets: saved create-box states per workspace and modality, loaded with one tap. */
export function presetRoutes(app: FastifyInstance) {
  app.get('/api/presets', async request => {
    const { workspaceId, modality } = request.query as Record<string, string | undefined>;
    await ownWorkspace(uid(request), workspaceId);
    const rows = await q(
      `select * from presets where workspace_id = $1 and ($2::text is null or modality = $2)
        order by last_used_at desc nulls last, lower(name)`, [workspaceId, modality === 'image' || modality === 'video' ? modality : null]);
    return Promise.all(rows.map(presetDto));
  });

  app.post('/api/presets', async request => {
    const body = (request.body || {}) as PresetState & { workspaceId?: string; modality?: string; name?: string };
    await ownWorkspace(uid(request), body.workspaceId);
    if (body.modality !== 'image' && body.modality !== 'video') bad('Choose photo or video.');
    const name = cleanName(body.name);
    if (!name) bad('Give the preset a name.');
    const s = await cleanState(body.workspaceId!, body);
    const row = await one(
      `insert into presets (workspace_id, modality, name, model_id, prompt, settings, ref_slots, folder_id, batch, last_used_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) returning *`,
      [body.workspaceId, body.modality, name, s.modelId, s.prompt, JSON.stringify(s.settings), JSON.stringify(s.slots), s.folderId, s.batch])
      .catch(error => taken(error, name));
    return presetDto(row);
  });

  /** Rename, or replace the saved state with the create box's current one (`state`). */
  app.patch('/api/presets/:id', async request => {
    const { id } = request.params as { id: string };
    const preset = await ownRow(uid(request), 'presets', id);
    const body = (request.body || {}) as { name?: string; state?: PresetState };
    let row = preset;
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) bad('Give the preset a name.');
      row = await one('update presets set name = $2, updated_at = now() where id = $1 returning *', [id, name]).catch(error => taken(error, name));
    }
    if (body.state) {
      const s = await cleanState(preset.workspace_id, body.state);
      row = await one(
        `update presets set model_id = $2, prompt = $3, settings = $4, ref_slots = $5, folder_id = $6, batch = $7, updated_at = now(), last_used_at = now()
         where id = $1 returning *`,
        [id, s.modelId, s.prompt, JSON.stringify(s.settings), JSON.stringify(s.slots), s.folderId, s.batch]);
    }
    return presetDto(row);
  });

  app.post('/api/presets/:id/used', async request => {
    const { id } = request.params as { id: string };
    await ownRow(uid(request), 'presets', id);
    await q('update presets set last_used_at = now() where id = $1', [id]);
    return { ok: true };
  });

  app.delete('/api/presets/:id', async request => {
    const { id } = request.params as { id: string };
    await ownRow(uid(request), 'presets', id);
    await q('delete from presets where id = $1', [id]);
    return { ok: true };
  });
}
