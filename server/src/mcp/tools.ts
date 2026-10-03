import { Readable } from 'node:stream';
import { one, q } from '../db.js';
import { notifyChange } from '../events.js';
import { providersFor } from '../providers/registry.js';
import { ProviderError, type Modality, type ModelInfo } from '../providers/types.js';
import { autoModels, favorites, status } from '../routes/providers.js';
import { useEnvironment } from '../routes/environments.js';
import { environmentFor, refFromAsset } from '../routes/workspace.js';
import { ownedIds } from '../services/access.js';
import { allowsWorkspace, requirePerm, type Agent, type Perm } from '../services/apiTokens.js';
import { deleteAssets, folderByName, moveAssets, saveAsset } from '../services/assets.js';
import { ACTIVE, createGenerations, modelFor, quoteGeneration, type GenerateInput } from '../services/generations.js';
import { storeFromUrl, storeStream } from '../services/media.js';
import { enhancePrompt } from '../services/promptAssist.js';
import { clampWait, mergePreset, modelDetails, modelSummary, pickOne, referenceSlots, type PresetState } from './resolve.js';

/** Who is calling: the agent (API token), its user, and the base URL results can be downloaded from. */
export interface ToolContext { userId: string; agent: Agent; origin: string }

export interface Tool {
  name: string;
  description: string;
  perm?: Perm;
  properties: Record<string, unknown>;
  required?: string[];
  run: (ctx: ToolContext, args: Record<string, any>) => Promise<unknown>;
}

const bad = (message: string, status = 400): never => { throw new ProviderError(message, status); };
const UUID = /^[0-9a-f-]{36}$/;
const uuids = (value: unknown) => (Array.isArray(value) ? value : [value]).map(String).filter(id => UUID.test(id));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const MODALITY = { type: 'string', enum: ['image', 'video'] };
const WORKSPACE = { type: 'string', description: 'Workspace name or id. Optional when the key can use only one workspace.' };

// ---------------------------------------------------------------- lookups (all scoped to the agent)

async function workspaces(ctx: ToolContext) {
  const rows = await q('select * from workspaces where user_id = $1 order by created_at', [ctx.userId]);
  return rows.filter(w => allowsWorkspace(ctx.agent, w.id)).map(w => ({ id: w.id as string, name: w.name as string, row: w }));
}

async function workspace(ctx: ToolContext, value: unknown) {
  const list = await workspaces(ctx);
  if ((value === undefined || value === null || value === '') && list.length === 1) return list[0];
  return pickOne(list, value, 'workspace');
}

/** Ids of the agent's own rows in its allowed workspaces (others are silently dropped, like bulk routes). */
async function allowed(ctx: ToolContext, table: 'assets' | 'generations', ids: string[]) {
  const owned = await ownedIds(ctx.userId, table, ids);
  if (!owned.length || !ctx.agent.workspaceIds) return owned;
  return (await q<{ id: string }>(`select id from ${table} where id = any($1::uuid[]) and workspace_id = any($2::uuid[])`,
    [owned, ctx.agent.workspaceIds])).map(r => r.id);
}

interface ModelEntry { id: string; name: string; model: ModelInfo; provider: string; auto: boolean }

/** Every model the user can generate with: their Auto models first, then each connected provider's. */
async function models(ctx: ToolContext, modality?: Modality): Promise<ModelEntry[]> {
  const out: ModelEntry[] = [];
  for (const m of modality ? [modality] : (['image', 'video'] as Modality[])) {
    for (const model of await autoModels(ctx.userId, m)) out.push({ id: model.id, name: model.name, model, provider: 'Auto', auto: true });
    for (const provider of providersFor(ctx.userId)) {
      const s = await status(ctx.userId, provider.id);
      if (!s.configured || !s.enabled) continue;
      const list = await provider.listModels(m).catch(() => [] as ModelInfo[]);
      for (const model of list) if (model.available) out.push({ id: model.id, name: model.name, model, provider: provider.name, auto: false });
    }
  }
  return out;
}

/** A model by id or name. A name that's both an Auto model and a provider's model means the Auto one. */
async function findModel(ctx: ToolContext, value: unknown): Promise<ModelEntry> {
  const wanted = String(value ?? '').trim();
  if (!wanted) bad('Say which model (an id from list_models, or its name).');
  if (wanted.includes(':') && !wanted.startsWith('auto:')) {
    try {
      const { provider, model } = await modelFor(ctx.userId, wanted);
      return { id: model.id, name: model.name, model, provider: provider.name, auto: false };
    } catch { /* fall through to the name lookup's helpful error */ }
  }
  const all = await models(ctx);
  const auto = all.filter(m => m.auto && (m.id === wanted || m.name.toLowerCase() === wanted.toLowerCase()));
  return auto.length === 1 ? auto[0] : pickOne(all, wanted, 'model');
}

/** References by id, result (asset) id or name; environment photos by name become workspace refs. */
async function resolveRefs(ctx: ToolContext, workspaceId: string, model: ModelInfo, wanted: Record<string, string[]>) {
  const slots: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(wanted)) {
    const field = model.refFields.find(f => f.key === key)!;
    const refs = await q('select id, name, created_at from refs where workspace_id = $1 and kind = $2 and source_environment_id is null order by created_at desc', [workspaceId, field.kind]);
    const envs = await q('select id, name from environments where user_id = $1 and kind = $2 order by created_at desc', [ctx.userId, field.kind]);
    slots[key] = [];
    for (const value of values) {
      if (UUID.test(value)) {
        if (await one('select 1 from refs where id = $1 and workspace_id = $2', [value, workspaceId])) { slots[key].push(value); continue; }
        if ((await allowed(ctx, 'assets', [value])).length && await one('select 1 from assets where id = $1 and workspace_id = $2', [value, workspaceId])) {
          slots[key].push((await refFromAsset(ctx.userId, value, false)).id); continue;
        }
        if (envs.some(e => e.id === value)) { slots[key].push((await useEnvironment(ctx.userId, workspaceId, value)).id); continue; }
        bad(`Reference ${value} was not found in this workspace.`, 404);
      }
      // Names: a workspace reference wins (newest if several share a name), then an environment photo.
      const ref = refs.find(r => r.name.toLowerCase() === value.toLowerCase());
      if (ref) { slots[key].push(ref.id); continue; }
      const env = envs.find(e => e.name.toLowerCase() === value.toLowerCase());
      if (env) { slots[key].push((await useEnvironment(ctx.userId, workspaceId, env.id)).id); continue; }
      const picked = pickOne([...refs.map(r => ({ id: r.id, name: r.name, env: false })), ...envs.map(e => ({ id: e.id, name: e.name, env: true }))],
        value, `${field.kind} reference`);
      slots[key].push(picked.env ? (await useEnvironment(ctx.userId, workspaceId, picked.id)).id : picked.id);
    }
  }
  return slots;
}

/** A folder by id or name; "unsorted" or empty = no folder. Missing folders are created when allowed. */
async function resolveFolder(ctx: ToolContext, workspaceId: string, value: unknown, create: boolean) {
  const wanted = String(value ?? '').trim();
  if (!wanted || wanted.toLowerCase() === 'unsorted') return null;
  const folders = await q<{ id: string; name: string }>('select id, name from folders where workspace_id = $1 order by lower(name)', [workspaceId]);
  const found = folders.find(f => f.id === wanted || f.name.toLowerCase() === wanted.toLowerCase());
  if (found) return found.id;
  if (!create) return pickOne(folders, wanted, 'folder').id;
  if (!ctx.agent.perms.includes('folders')) bad(`There's no folder "${wanted}", and this key isn't allowed to create folders.`, 404);
  return (await folderByName(workspaceId, wanted.slice(0, 60))).id;
}

async function presetState(ctx: ToolContext, workspaceId: string, value: unknown): Promise<PresetState | null> {
  if (value === undefined || value === null || value === '') return null;
  requirePerm(ctx.agent, 'presets');
  const rows = await q<any>('select * from presets where workspace_id = $1 order by lower(name)', [workspaceId]);
  const p = pickOne(rows, value, 'preset');
  await q('update presets set last_used_at = now() where id = $1', [p.id]);
  return { modelId: p.model_id, prompt: p.prompt, settings: p.settings || {}, refSlots: p.ref_slots || {}, folderId: p.folder_id, batch: p.batch };
}

/** generate/quote arguments → the same input the create box sends. */
async function buildInput(ctx: ToolContext, args: Record<string, any>, forQuote: boolean) {
  const ws = await workspace(ctx, args.workspace);
  const merged = mergePreset(await presetState(ctx, ws.id, args.preset), args);
  const entry = await findModel(ctx, merged.model);
  const model = entry.model;
  const refSlots = merged.references !== null
    ? await resolveRefs(ctx, ws.id, model, referenceSlots(merged.references, model))
    : Object.fromEntries(Object.entries(merged.presetRefs).filter(([key]) => model.refFields.some(f => f.key === key)));
  const folderId = args.folder !== undefined
    ? (forQuote ? null : await resolveFolder(ctx, ws.id, args.folder, true))
    : merged.presetFolderId;
  const input: GenerateInput = {
    workspaceId: ws.id, modelId: entry.id, prompt: merged.prompt, settings: merged.settings, refSlots, folderId, batch: merged.batch,
  };
  return { input, entry, workspace: ws };
}

// ---------------------------------------------------------------- results

const assetOut = (ctx: ToolContext, a: any) => ({
  id: a.id, kind: a.kind, mime: a.mime, width: a.width, height: a.height, duration: a.duration,
  url: `${ctx.origin}/api/agent/files/${a.id}`,
  cleanUrl: `${ctx.origin}/api/agent/files/${a.id}?clean=1`,
  saved: (a.exported_paths || []).length > 0,
});

async function results(ctx: ToolContext, ids: string[]) {
  const ok = await allowed(ctx, 'generations', ids);
  if (!ok.length) return [];
  const rows = await q(
    `select g.*, f.name as folder_name from generations g left join folders f on f.id = g.folder_id
      where g.id = any($1::uuid[]) order by g.created_at`, [ok]);
  const assets = await q('select * from assets where generation_id = any($1::uuid[]) order by idx', [ok]);
  return rows.map(g => ({
    id: g.id, status: g.status, ...(g.error ? { error: g.error } : {}),
    model: g.model_name, provider: g.provider_id,
    ...(g.resolved_input?.auto ? { autoModel: g.resolved_input.auto.modelId } : {}),
    ...(g.cost != null ? { cost: Number(g.cost), costUnit: g.cost_unit } : {}),
    folder: g.folder_name || 'Unsorted', createdAt: g.created_at,
    assets: assets.filter(a => a.generation_id === g.id).map(a => assetOut(ctx, a)),
  }));
}

async function waitFor(ctx: ToolContext, ids: string[], seconds: number) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const list = await results(ctx, ids);
    if (Date.now() >= until || !list.some(g => ACTIVE.includes(g.status))) return list;
    await sleep(2000);
  }
}

const WAIT = { type: 'number', description: 'Seconds to wait for the results before answering (0–300). Call get_results again to keep waiting.' };

// ---------------------------------------------------------------- the tools

export const TOOLS: Tool[] = [
  {
    name: 'list_workspaces',
    description: 'Workspaces this key can use (e.g. one per influencer).',
    properties: {},
    run: async ctx => (await workspaces(ctx)).map(w => ({ id: w.id, name: w.name, imageFolder: w.row.image_export_dir, videoFolder: w.row.video_export_dir })),
  },
  {
    name: 'list_models',
    description: 'Models you can generate with. "Auto" models go to the cheapest provider with enough balance (uncensored and regular are separate Auto models). Use get_model for a model\'s settings.',
    properties: { modality: MODALITY, search: { type: 'string', description: 'Only models whose name contains this.' } },
    run: async (ctx, args) => {
      const favs = new Set(await favorites(ctx.userId));
      const term = String(args.search || '').toLowerCase();
      const list = (await models(ctx, args.modality)).filter(m => !term || m.name.toLowerCase().includes(term));
      const rank = (m: ModelEntry) => (m.auto ? 0 : favs.has(m.id) ? 1 : 2);
      return list.sort((a, b) => rank(a) - rank(b)).map(m => ({ modality: m.model.modality, ...modelSummary(m.model, { provider: m.provider, favorite: favs.has(m.id) }) }));
    },
  },
  {
    name: 'get_model',
    description: 'A model\'s settings (with allowed values and defaults) and reference inputs, to call generate with.',
    properties: { model: { type: 'string', description: 'Model id or name.' } },
    required: ['model'],
    run: async (ctx, args) => {
      const m = await findModel(ctx, args.model);
      return modelDetails(m.model, m.provider);
    },
  },
  {
    name: 'list_folders',
    description: 'Folders in a workspace, with how many results each holds.',
    properties: { workspace: WORKSPACE },
    run: async (ctx, args) => {
      const ws = await workspace(ctx, args.workspace);
      return q(`select f.id, f.name, count(a.id)::int as results from folders f left join assets a on a.folder_id = f.id
                 where f.workspace_id = $1 group by f.id order by lower(f.name)`, [ws.id]);
    },
  },
  {
    name: 'create_folder',
    description: 'Create a folder (or get the existing one with that name).',
    perm: 'folders',
    properties: { workspace: WORKSPACE, name: { type: 'string' } },
    required: ['name'],
    run: async (ctx, args) => {
      const ws = await workspace(ctx, args.workspace);
      const name = String(args.name || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60) || bad('Name the folder.');
      const folder = await folderByName(ws.id, name);
      notifyChange(ctx.userId);
      return folder;
    },
  },
  {
    name: 'list_references',
    description: 'Reference photos/videos you can pass to generate by name: "model" (model refs), "uploads", "generated" (results used as refs), "environments" (shared environment library) or "all".',
    properties: {
      workspace: WORKSPACE,
      library: { type: 'string', enum: ['all', 'model', 'uploads', 'generated', 'environments'] },
      kind: { type: 'string', enum: ['image', 'video', 'audio'] },
      search: { type: 'string' }, limit: { type: 'number', description: 'Up to 200 (default 100).' },
    },
    run: async (ctx, args) => {
      const ws = await workspace(ctx, args.workspace);
      const library = args.library || 'all';
      const term = `%${String(args.search || '').replace(/[%_]/g, '')}%`;
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 200);
      const kind = ['image', 'video', 'audio'].includes(args.kind) ? args.kind : null;
      const out: unknown[] = [];
      if (library !== 'environments') {
        const filter = library === 'model' ? 'and is_model_ref' : library === 'uploads' ? 'and not is_model_ref and source_asset_id is null'
          : library === 'generated' ? 'and source_asset_id is not null' : '';
        const rows = await q(
          `select * from refs where workspace_id = $1 and source_environment_id is null ${filter}
             and ($2::text is null or kind = $2) and name ilike $3 order by created_at desc limit ${limit}`, [ws.id, kind, term]);
        out.push(...rows.map(r => ({ id: r.id, name: r.name, kind: r.kind, library: r.is_model_ref ? 'model' : r.source_asset_id ? 'generated' : 'uploads', width: r.width, height: r.height })));
      }
      if (library === 'environments' || library === 'all') {
        const rows = await q(`select * from environments where user_id = $1 and ($2::text is null or kind = $2) and name ilike $3 order by created_at desc limit ${limit}`,
          [ctx.userId, kind, term]);
        out.push(...rows.map(e => ({ id: e.id, name: e.name, kind: e.kind, library: 'environments', width: e.width, height: e.height })));
      }
      return out.slice(0, limit);
    },
  },
  {
    name: 'list_elements',
    description: 'Elements (named subjects like a model\'s face) to mention as @Name in prompts.',
    properties: { workspace: WORKSPACE },
    run: async (ctx, args) => {
      const ws = await workspace(ctx, args.workspace);
      return q(`select e.name, e.description, count(er.ref_id)::int as photos from elements e left join element_refs er on er.element_id = e.id
                 where e.workspace_id = $1 group by e.id order by lower(e.name)`, [ws.id]);
    },
  },
  {
    name: 'upload_reference',
    description: 'Add a reference from a URL or base64 data, to the workspace\'s "uploads" or "model" refs, or to the shared "environments" library. Then use its name or id in generate.',
    perm: 'upload',
    properties: {
      workspace: WORKSPACE,
      library: { type: 'string', enum: ['uploads', 'model', 'environments'] },
      url: { type: 'string', description: 'http(s) URL of the file.' },
      data: { type: 'string', description: 'Base64 file contents (or a data: URL), instead of url.' },
      mime: { type: 'string', description: 'e.g. image/jpeg (needed with base64 data unless it\'s a data: URL).' },
      name: { type: 'string' },
    },
    run: async (ctx, args) => {
      const ws = await workspace(ctx, args.workspace);
      const library = args.library || 'uploads';
      let stored;
      if (args.url) {
        if (!/^https?:\/\//i.test(String(args.url))) bad('url must start with http:// or https://.');
        stored = await storeFromUrl(String(args.url), String(args.mime || ''));
      } else if (args.data) {
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(args.data));
        const bytes = Buffer.from(match ? match[2] : String(args.data), 'base64');
        if (!bytes.length) bad('data is empty or not base64.');
        stored = await storeStream(Readable.from(bytes), match?.[1] || String(args.mime || ''));
      } else bad('Pass url or data.');
      const name = String(args.name || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 80) || 'Reference';
      if (library === 'environments') {
        const env = await environmentFor(ctx.userId, { ...stored!, name });
        notifyChange(ctx.userId);
        return { id: env.id, name: env.name, kind: env.kind, library };
      }
      const row = await one(
        `insert into refs (workspace_id, kind, name, file, thumb, mime, width, height, is_model_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [ws.id, stored!.kind, name, stored!.file, stored!.thumb, stored!.mime, stored!.width, stored!.height, library === 'model']);
      notifyChange(ctx.userId);
      return { id: row.id, name: row.name, kind: row.kind, library };
    },
  },
  {
    name: 'list_presets',
    description: 'Saved create-box presets (model, prompt, settings, references, folder) to pass as generate\'s "preset".',
    perm: 'presets',
    properties: { workspace: WORKSPACE, modality: MODALITY },
    run: async (ctx, args) => {
      const ws = await workspace(ctx, args.workspace);
      const rows = await q(`select * from presets where workspace_id = $1 and ($2::text is null or modality = $2) order by lower(name)`,
        [ws.id, args.modality === 'image' || args.modality === 'video' ? args.modality : null]);
      return rows.map(p => ({ id: p.id, name: p.name, modality: p.modality, model: p.model_id, prompt: p.prompt, settings: p.settings, batch: p.batch }));
    },
  },
  {
    name: 'enhance_prompt',
    description: 'Optional: rewrite a short prompt into a detailed one for the chosen model and its settings, using the user’s prompt assistant (an LLM via OpenRouter, with their general and workspace preferences). Every @image/@element token is kept. Pass the same workspace, model, settings and references you will generate with, then call generate with the returned prompt and original_prompt. Costs about 1–2 cents of the user’s OpenRouter credit; skip it when your prompt is already detailed.',
    perm: 'generate',
    properties: {
      workspace: WORKSPACE,
      model: { type: 'string', description: 'Model id or name you will generate with.' },
      prompt: { type: 'string', description: 'What you want, in plain words; @image1… and @Element tokens allowed.' },
      settings: { type: 'object', description: 'The settings you will generate with (duration, aspect ratio…), so the rewrite fits them.' },
      references: generateProps().references,
      show_references: { type: 'boolean', description: 'Let the assistant see the reference photos (default: the user’s setting).' },
    },
    required: ['model', 'prompt'],
    run: async (ctx, args) => {
      // Same resolution as generate (names → ids); no folder or preset involved.
      const { input, entry, workspace: ws } = await buildInput(ctx, { ...args, preset: undefined, folder: undefined }, true);
      const result = await enhancePrompt(ctx.userId, entry.model, {
        workspaceId: ws.id, prompt: String(args.prompt || ''), settings: input.settings, refSlots: input.refSlots,
        ...(typeof args.show_references === 'boolean' ? { showRefs: args.show_references } : {}),
      });
      return {
        prompt: result.prompt, original_prompt: String(args.prompt || ''), warnings: result.warnings,
        assistant: result.model, ...(result.cost ? { costUsd: result.cost } : {}),
        next: result.warnings.length ? 'Some @ tokens did not survive: check them or call enhance_prompt again.' : 'Call generate with this prompt and original_prompt.',
      };
    },
  },
  {
    name: 'quote',
    description: 'Price a generation without running it (same arguments as generate). Free.',
    perm: 'generate',
    properties: generateProps(),
    run: async (ctx, args) => {
      const { input, entry } = await buildInput(ctx, args, true);
      const cost = await quoteGeneration(ctx.userId, input);
      return { model: entry.name, ...(cost || { price: 'unknown' }) };
    },
  },
  {
    name: 'generate',
    description: 'Generate images or videos. Results appear in the studio; get them with get_results (or wait here). Costs money: check with quote when unsure.',
    perm: 'generate',
    properties: {
      ...generateProps(), wait_seconds: WAIT,
      original_prompt: { type: 'string', description: 'When prompt came from enhance_prompt: the short prompt it was rewritten from (shown in the studio as the original).' },
    },
    run: async (ctx, args) => {
      const { input } = await buildInput(ctx, args, false);
      if (typeof args.original_prompt === 'string' && args.original_prompt.trim()) input.originalPrompt = args.original_prompt;
      const rows = await createGenerations(ctx.userId, input, ctx.agent.id);
      notifyChange(ctx.userId);
      const ids = rows.map(r => r.id);
      const wait = clampWait(args.wait_seconds);
      return { generationIds: ids, results: wait ? await waitFor(ctx, ids, wait) : await results(ctx, ids) };
    },
  },
  {
    name: 'get_results',
    description: 'Status and files of generations. Each file has a url (original) and cleanUrl (metadata stripped); download them with the same Authorization header.',
    properties: { generationIds: { type: 'array', items: { type: 'string' } }, wait_seconds: WAIT },
    required: ['generationIds'],
    run: async (ctx, args) => waitFor(ctx, uuids(args.generationIds), clampWait(args.wait_seconds)),
  },
  {
    name: 'list_results',
    description: 'Recent results in a workspace, newest first.',
    properties: {
      workspace: WORKSPACE,
      folder: { type: 'string', description: 'Folder name or id, "unsorted", or omit for all.' },
      kind: { type: 'string', enum: ['image', 'video'] },
      limit: { type: 'number', description: 'Up to 100 (default 30).' },
      before: { type: 'string', description: 'createdAt of the last item seen, for the next page.' },
    },
    run: async (ctx, args) => {
      const ws = await workspace(ctx, args.workspace);
      const params: unknown[] = [ws.id];
      let where = 'a.workspace_id = $1';
      if (args.folder !== undefined && args.folder !== null && args.folder !== '') {
        const folderId = await resolveFolder(ctx, ws.id, args.folder, false);
        if (folderId) { params.push(folderId); where += ` and a.folder_id = $${params.length}`; } else where += ' and a.folder_id is null';
      }
      if (args.kind === 'image' || args.kind === 'video') { params.push(args.kind); where += ` and a.kind = $${params.length}`; }
      if (args.before) { params.push(String(args.before)); where += ` and a.created_at < $${params.length}::timestamptz`; }
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const rows = await q(
        `select a.*, g.prompt, g.model_name, f.name as folder_name from assets a join generations g on g.id = a.generation_id
           left join folders f on f.id = a.folder_id where ${where} order by a.created_at desc limit ${limit}`, params);
      return rows.map(a => ({
        ...assetOut(ctx, a), generationId: a.generation_id, model: a.model_name, prompt: String(a.prompt || '').slice(0, 300),
        folder: a.folder_name || 'Unsorted', createdAt: a.created_at,
      }));
    },
  },
  {
    name: 'save_results',
    description: 'Save results to the save location (NAS or server folder) in the workspace\'s image/video folder, with metadata stripped if that\'s on in Settings. Returns where each landed.',
    perm: 'save',
    properties: { assetIds: { type: 'array', items: { type: 'string' } } },
    required: ['assetIds'],
    run: async (ctx, args) => {
      const ids = await allowed(ctx, 'assets', uuids(args.assetIds));
      if (!ids.length) bad('None of those results were found.', 404);
      const out = [];
      for (const id of ids) {
        try { out.push({ assetId: id, path: await saveAsset(ctx.userId, id) }); }
        catch (error: any) { out.push({ assetId: id, error: error.message }); }
      }
      notifyChange(ctx.userId);
      return out;
    },
  },
  {
    name: 'move_results',
    description: 'Move results into a folder (by name or id; created if missing), or "unsorted".',
    perm: 'folders',
    properties: { assetIds: { type: 'array', items: { type: 'string' } }, folder: { type: 'string' } },
    required: ['assetIds', 'folder'],
    run: async (ctx, args) => {
      const ids = await allowed(ctx, 'assets', uuids(args.assetIds));
      if (!ids.length) bad('None of those results were found.', 404);
      const first = await one('select workspace_id from assets where id = $1', [ids[0]]);
      const folderId = await resolveFolder(ctx, first.workspace_id, args.folder, true);
      const moved = await moveAssets(ctx.userId, ids, folderId);
      notifyChange(ctx.userId);
      return { moved };
    },
  },
  {
    name: 'delete_results',
    description: 'Delete results from the studio (copies already saved to the save location are kept).',
    perm: 'delete',
    properties: { assetIds: { type: 'array', items: { type: 'string' } } },
    required: ['assetIds'],
    run: async (ctx, args) => {
      const ids = await allowed(ctx, 'assets', uuids(args.assetIds));
      if (!ids.length) bad('None of those results were found.', 404);
      const deleted = await deleteAssets(ctx.userId, ids);
      notifyChange(ctx.userId);
      return { deleted };
    },
  },
  {
    name: 'get_balances',
    description: 'Balance left at each connected provider.',
    properties: {},
    run: async ctx => {
      const out = [];
      for (const p of providersFor(ctx.userId)) {
        const s = await status(ctx.userId, p.id);
        if (!p.balance || !s.configured || !s.enabled) continue;
        try { out.push({ provider: p.name, ...(await p.balance()) }); }
        catch (error: any) { out.push({ provider: p.name, error: error.message }); }
      }
      return out;
    },
  },
];

function generateProps(): Record<string, unknown> {
  return {
    workspace: WORKSPACE,
    model: { type: 'string', description: 'Model id or name from list_models (Auto models recommended). Optional with a preset.' },
    prompt: { type: 'string', description: 'Use @Name for elements and @image1… for references by position.' },
    settings: { type: 'object', description: 'Setting key → value, as listed by get_model. Missing ones use defaults.' },
    references: {
      description: 'Reference names or ids (or result ids): a list for the model\'s main input, or {"input key": [...]} per input.',
      anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object' }],
    },
    folder: { type: 'string', description: 'Folder name or id for the results (created if missing, if allowed), or "unsorted".' },
    batch: { type: 'number', description: 'How many to generate: 1, 2, 3, 4, 6 or 8.' },
    preset: { type: 'string', description: 'Preset name or id to start from; arguments you pass override it.' },
  };
}

export const INSTRUCTIONS = `Spicy Studio: generate AI images and videos into the user's studio.
Typical flow: list_workspaces → list_models (prefer "Auto" models: cheapest provider, uncensored and regular kept apart) → get_model for its settings → generate (with folder, references by name, @Element mentions in the prompt) → get_results with wait_seconds until status is "succeeded" → download a file's url or cleanUrl (metadata stripped) with this same Authorization header, or save_results to put them in the user's save location.
Optional: enhance_prompt rewrites a short prompt into a detailed one for the chosen model (keeps @ tokens); then pass both to generate (prompt + original_prompt).
Generations cost real money: use quote when unsure, and don't retry failures in a loop.`;
