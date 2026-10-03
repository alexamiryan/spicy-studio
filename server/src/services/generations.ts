import { randomUUID } from 'node:crypto';
import { one, q, tx } from '../db.js';
import { getProvider, splitModelId } from '../providers/registry.js';
import { ProviderError, type CreateRequest, type ElementInput, type ModelInfo, type Provider } from '../providers/types.js';
import { absPath, ensureQuotePlaceholder, storeFromUrl } from './media.js';
import { resolvePrompt } from './prompt.js';
import { notifyChange } from '../events.js';
import { ownWorkspace } from './access.js';
import { AUTO, route } from './router.js';

// 'enhancing': the prompt assistant is rewriting the prompt (auto-enhance) before the job is submitted.
export const ACTIVE = ['enhancing', 'pending', 'queued', 'running', 'saving'];

/** Batch sizes offered in the create box. Each item is its own provider job, so any provider supports them. */
export const BATCH_SIZES = [1, 2, 3, 4, 6, 8];
const clampBatch = (value: unknown) => Math.min(Math.max(Math.round(Number(value) || 1), 1), Math.max(...BATCH_SIZES));

export interface GenerateInput {
  workspaceId: string;
  modelId: string;
  prompt?: string;
  settings?: Record<string, unknown>;
  refSlots?: Record<string, string[]>;
  folderId?: string | null;
  batch?: number;
  /** The user's own words when the prompt was rewritten by the prompt assistant (kept for Recreate). */
  originalPrompt?: string;
  /** Auto-enhance: rewrite the prompt with the prompt assistant as the first step of the job (no preview). */
  enhance?: boolean;
  /** Auto-enhance: let the assistant see the references (default: the user's setting). */
  showRefs?: boolean;
}

function bad(message: string): never { throw new ProviderError(message, 400); }

/** The ref field that numbered @imageN mentions and @Elements map onto. */
export function primaryRefField(model: ModelInfo) {
  return model.refFields.find(f => f.primary && f.kind === 'image') || model.refFields.find(f => f.kind === 'image' && f.max > 1) || model.refFields.find(f => f.kind === 'image');
}

function cleanSettings(model: ModelInfo, settings: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const field of model.fields) {
    const value = settings[field.key];
    if (value === undefined || value === null || value === '') {
      if (field.required && field.default === undefined) bad(`${field.label} is required.`);
      continue;
    }
    if (field.type === 'enum' && !field.options?.some(o => String(o) === String(value))) bad(`Invalid value for ${field.label}.`);
    if ((field.type === 'number' || field.type === 'integer') && typeof value !== 'number') bad(`${field.label} must be a number.`);
    if (field.type === 'boolean' && typeof value !== 'boolean') bad(`${field.label} must be on or off.`);
    // Enum options may be numbers; keep the option's own type. Whole-number fields are rounded.
    out[field.key] = field.type === 'enum' ? field.options!.find(o => String(o) === String(value))
      : field.type === 'integer' ? Math.round(value as number) : value;
  }
  return out;
}

async function buildRequest(workspaceId: string, model: ModelInfo, input: GenerateInput, forQuote = false) {
  const prompt = String(input.prompt || '').slice(0, 20000);
  if (model.promptField && !prompt.trim() && !model.refFields.some(f => (input.refSlots?.[f.key] || []).length)) bad('Write a prompt first.');
  const settings = cleanSettings(model, input.settings || {});
  const primary = primaryRefField(model);
  const slots: Record<string, string[]> = {};
  for (const field of model.refFields) {
    const ids = input.refSlots?.[field.key] || [];
    if (!Array.isArray(ids)) bad(`Invalid references for ${field.label}.`);
    slots[field.key] = [...new Set(ids.map(String))];
  }
  const elements = await q<{ id: string; name: string; description: string; ref_ids: string[] }>(
    `select e.id, e.name, e.description,
            coalesce(array_agg(er.ref_id order by er.position) filter (where r.kind = 'image'), '{}') as ref_ids
       from elements e left join element_refs er on er.element_id = e.id left join refs r on r.id = er.ref_id
      where e.workspace_id = $1 group by e.id`, [workspaceId]);
  const native = model.nativeElements;
  const resolved = resolvePrompt(prompt, primary ? slots[primary.key] : [], elements.map(e => ({ name: e.name, refIds: e.ref_ids })), Boolean(native));
  let used: { id: string; name: string; description: string; refIds: string[] }[] = [];
  if (native) {
    used = resolved.usedElements.map(lower => elements.find(e => e.name.toLowerCase() === lower)!)
      .map(e => ({ id: e.id, name: e.name, description: e.description, refIds: e.ref_ids.slice(0, native.maxImages) }));
    if (used.length > native.max) bad(`${model.name} takes at most ${native.max} element${native.max === 1 ? '' : 's'} per generation.`);
    for (const e of used) {
      if (e.refIds.length < native.minImages) bad(`@${e.name} needs at least ${native.minImages} photos for ${model.name} (it has ${e.refIds.length}).`);
    }
    const needs = native.requiresSetting;
    if (used.length && needs && String(settings[needs.key] ?? model.fields.find(f => f.key === needs.key)?.default) !== String(needs.value)) {
      const field = model.fields.find(f => f.key === needs.key);
      bad(`@elements on ${model.name} only work with ${field?.label || needs.key} set to ${String(needs.value).toUpperCase()}.`);
    }
    if (used.length && native.requiresRef && !(slots[native.requiresRef] || []).length) {
      const field = model.refFields.find(f => f.key === native.requiresRef);
      bad(`${model.name} needs a ${(field?.label || native.requiresRef).toLowerCase()} to use @elements.`);
    }
  } else {
    if (resolved.usedElements.length && !primary) bad('This model does not take reference images, so @elements cannot be used.');
    if (primary) slots[primary.key] = resolved.refs;
  }
  for (const field of model.refFields) {
    const count = slots[field.key].length;
    if (field.required && !count && !forQuote) bad(`${field.label} needs at least one reference.`);
    if (count > field.max) bad(`${field.label} accepts at most ${field.max} reference${field.max === 1 ? '' : 's'} (got ${count}).`);
  }
  const allIds = Object.values(slots).flat();
  if (allIds.length) {
    const found = await q<{ id: string; kind: string }>('select id, kind from refs where workspace_id = $1 and id = any($2::uuid[])', [workspaceId, allIds]);
    const kinds = new Map(found.map(r => [r.id, r.kind]));
    for (const field of model.refFields) {
      for (const id of slots[field.key]) {
        if (!kinds.has(id)) bad('A selected reference no longer exists.');
        if (kinds.get(id) !== field.kind) bad(`${field.label} only accepts ${field.kind} files.`);
      }
    }
  }
  return { prompt, settings, slots, elements: used, resolvedPrompt: resolved.prompt };
}

export async function modelFor(userId: string, modelId: string) {
  const { providerId, model } = splitModelId(modelId);
  const provider = getProvider(userId, providerId);
  return { provider, model: await provider.getModel(model) };
}

/** Owner of a generation (through its workspace). */
async function ownerOf(generationId: string): Promise<string | undefined> {
  return (await one<{ user_id: string }>(
    'select w.user_id from generations g join workspaces w on w.id = g.workspace_id where g.id = $1', [generationId]))?.user_id;
}

const isAuto = (modelId: string) => modelId.startsWith(`${AUTO}:`);

/** An Auto model's request, resolved to the cheapest affordable provider's model, settings and references. */
async function routed(userId: string, input: GenerateInput) {
  const { chosen } = await route(userId, input.modelId, input.settings || {}, input.refSlots || {},
    (modelId, settings, refSlots) => quoteConcrete(userId, { ...input, modelId, settings, refSlots }));
  return { chosen, input: { ...input, modelId: chosen.model.id, settings: chosen.settings, refSlots: chosen.refSlots } };
}

export async function quoteGeneration(userId: string, input: GenerateInput) {
  if (!isAuto(input.modelId)) return quoteConcrete(userId, input);
  await ownWorkspace(userId, input.workspaceId);
  const { chosen } = await routed(userId, input);
  return chosen.cost && { ...chosen.cost, via: chosen.provider.name, modelName: chosen.model.name, uncensored: chosen.uncensored };
}

async function quoteConcrete(userId: string, input: GenerateInput) {
  await ownWorkspace(userId, input.workspaceId);
  const { provider, model } = await modelFor(userId, input.modelId);
  const built = await buildRequest(input.workspaceId, model, input, true);
  // Providers validate references when pricing (SpicyAPI rejects a quote without them), so upload
  // them now. Uploads are cached per file, so the real generation reuses them.
  const refs: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(built.slots)) {
    if (ids.length) refs[key] = await Promise.all(ids.map(id => providerUri(userId, provider, id)));
  }
  // A required video/audio input decides the price (it's billed by length): no price until it's added.
  if (model.refFields.some(f => f.required && f.kind !== 'image' && !refs[f.key]?.length)) return null;
  // Empty image inputs are priced with a placeholder image, so the price shows before references are picked.
  const placeholder = () => placeholderUri(userId, provider);
  for (const field of model.refFields) {
    if (field.required && field.kind === 'image' && !refs[field.key]?.length) refs[field.key] = [await placeholder()];
  }
  const elements = await elementInputs(userId, provider, built.elements, false);
  const price = (withRefs: Record<string, string[]>) => provider.quote({
    model: model.model, modality: model.modality, prompt: built.resolvedPrompt, promptField: model.promptField,
    settings: built.settings, refs: withRefs, idempotencyKey: 'quote', quote: true, elements,
  });
  let cost = await price(refs).catch(error => { console.warn(`quote ${input.modelId}: ${error.message}`); return null; });
  // "At least one reference" models (e.g. reference-to-video) mark no single input as required.
  const primary = primaryRefField(model);
  if (!cost && primary && !Object.values(refs).some(list => list.length)) {
    cost = await price({ [primary.key]: [await placeholder()] }).catch(() => null);
  }
  const batch = clampBatch(input.batch);
  return cost ? { amount: cost.amount * batch, unit: cost.unit } : null;
}

/** `apiTokenId`: the agent (API token) that asked for it, shown in the studio as "Made by …". */
export async function createGenerations(userId: string, request: GenerateInput, apiTokenId: string | null = null) {
  await ownWorkspace(userId, request.workspaceId);
  // Auto models: generate with the cheapest provider whose balance covers it. What was picked in the
  // create box (the Auto model, its settings and references) is kept so Recreate and Animate restore it.
  const input = isAuto(request.modelId) ? (await routed(userId, request)).input : request;
  const auto = isAuto(request.modelId)
    ? { modelId: request.modelId, settings: request.settings || {}, refSlots: request.refSlots || {} } : undefined;
  const { provider, model } = await modelFor(userId, input.modelId);
  if (!model.available) bad('This model is currently unavailable.');
  const built = await buildRequest(input.workspaceId, model, input);
  const batch = clampBatch(input.batch);
  let folderId = input.folderId || null;
  if (folderId) {
    const folder = await one('select id from folders where id = $1 and workspace_id = $2', [folderId, input.workspaceId]);
    if (!folder) folderId = null;
    else await q('update folders set last_used_at = now() where id = $1', [folderId]);
  }
  const group = randomUUID();
  const enhance = request.enhance ? { showRefs: typeof request.showRefs === 'boolean' ? request.showRefs : undefined, done: false } : undefined;
  if (enhance) {
    const { assistSettings } = await import('./promptAssist.js');
    if (!(await assistSettings(userId)).configured) bad('Auto enhance needs an OpenRouter key: add one in Settings → Prompt assistant, or turn Auto off.');
  }
  const rows = await tx(async client => {
    const created = [];
    for (let i = 0; i < batch; i++) {
      const { rows } = await client.query(
        `insert into generations (workspace_id, folder_id, provider_id, model_id, model_name, modality, prompt, settings, ref_slots,
                                  batch_group, batch_size, resolved_input, status, idempotency_key, api_token_id, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$15,$13,$14, clock_timestamp()) returning *`,
        [input.workspaceId, folderId, provider.id, model.model, model.name, model.modality, built.prompt,
          JSON.stringify(built.settings), JSON.stringify(input.refSlots || {}), group, batch,
          JSON.stringify({
            prompt: built.resolvedPrompt, refs: built.slots, elements: built.elements, auto,
            ...(enhance ? { enhance, original: built.prompt }
              : request.originalPrompt && request.originalPrompt !== request.prompt ? { original: String(request.originalPrompt).slice(0, 20000) } : {}),
          }), randomUUID(), apiTokenId, enhance ? 'enhancing' : 'pending']);
      created.push(rows[0]);
    }
    return created;
  });
  // Submit batch items one after another: providers see a steady stream instead of a burst, and the
  // first item's reference uploads are reused by the rest. Auto enhance rewrites the prompt first.
  if (enhance) enhanceGroup(group).catch(error => console.error('enhance failed', error));
  else (async () => { for (const row of rows) await submit(row.id).catch(error => console.error('submit failed', error)); })();
  return rows;
}

const enhancing = new Set<string>();

/**
 * Auto enhance, the first step of a batch: rewrite the user's prompt once for the model that will run (after
 * Auto routing), rebuild the request with it, then submit every item. Nothing is charged before this, so a
 * failure just fails the batch with the reason (Retry runs the rewrite again), and a restart resumes it.
 */
export async function enhanceGroup(group: string) {
  if (enhancing.has(group)) return;
  enhancing.add(group);
  try {
    const rows = await q(
      `select g.*, w.user_id from generations g join workspaces w on w.id = g.workspace_id
        where g.batch_group = $1 and g.status = 'enhancing' order by g.created_at`, [group]);
    if (!rows.length) return;
    const g = rows[0];
    const original: string = g.resolved_input?.original ?? g.prompt;
    let built: Awaited<ReturnType<typeof buildRequest>>;
    try {
      const { model } = await modelFor(g.user_id, `${g.provider_id}:${g.model_id}`);
      const { enhancePrompt } = await import('./promptAssist.js');
      const result = await enhancePrompt(g.user_id, model, {
        workspaceId: g.workspace_id, prompt: original, settings: g.settings, refSlots: g.ref_slots,
        ...(typeof g.resolved_input?.enhance?.showRefs === 'boolean' ? { showRefs: g.resolved_input.enhance.showRefs } : {}),
      });
      if (result.warnings.length) throw new ProviderError(`${result.warnings.join(' ')} Nothing was generated.`);
      built = await buildRequest(g.workspace_id, model, {
        workspaceId: g.workspace_id, modelId: `${g.provider_id}:${g.model_id}`, prompt: result.prompt, settings: g.settings, refSlots: g.ref_slots,
      });
    } catch (error: any) {
      const reason = error instanceof ProviderError ? error.message : 'the rewrite failed.';
      if (!(error instanceof ProviderError)) console.error('enhance', error);
      for (const row of rows) await fail(row.id, `Prompt assistant: ${reason} Retry, or turn Auto enhance off.`);
      return;
    }
    for (const row of rows) {
      await q(
        `update generations set prompt = $2, resolved_input = $3, status = 'pending', updated_at = now() where id = $1 and status = 'enhancing'`,
        [row.id, built.prompt, JSON.stringify({
          ...row.resolved_input, prompt: built.resolvedPrompt, refs: built.slots, elements: built.elements,
          enhance: { ...row.resolved_input.enhance, done: true },
        })]);
    }
    notifyChange(g.user_id);
    for (const row of rows) await submit(row.id).catch(error => console.error('submit failed', error));
  } finally {
    enhancing.delete(group);
  }
}

// Uploads in progress, so concurrent jobs using the same file share one upload.

type Media = { uri: string; url?: string; file: string };
const uploading = new Map<string, Promise<Media>>();

async function providerUri(userId: string, provider: Provider, refId: string) {
  return (await providerMedia(userId, provider, refId)).uri;
}

/** A reference uploaded to a provider (once per file). `needUrl`: also its public URL (re-uploads older cache entries without one). */
async function providerMedia(userId: string, provider: Provider, refId: string, needUrl = false): Promise<Media> {
  const ref = await one<{ file: string; mime: string; name: string }>('select file, mime, name from refs where id = $1', [refId]);
  if (!ref) throw new ProviderError('A selected reference no longer exists.', 400);
  const key = `${userId}:${provider.id}:${ref.file}:${needUrl}`;
  const pending = uploading.get(key);
  if (pending) return pending;
  const task = uploadOnce(userId, provider, ref, needUrl).finally(() => uploading.delete(key));
  uploading.set(key, task);
  return task;
}

async function uploadOnce(userId: string, provider: Provider, ref: { file: string; mime: string; name: string }, needUrl: boolean): Promise<Media> {
  const cached = await one<{ uri: string; url: string | null; expires_at: Date | null }>(
    'select uri, url, expires_at from provider_uploads where user_id = $1 and file = $2 and provider_id = $3', [userId, ref.file, provider.id]);
  if (cached && (!cached.expires_at || cached.expires_at.getTime() - Date.now() > 10 * 60_000) && (!needUrl || cached.url)) {
    return { uri: cached.uri, url: cached.url || undefined, file: ref.file };
  }
  const ext = ref.file.slice(ref.file.lastIndexOf('.'));
  const uploaded = await provider.upload(absPath(ref.file), ref.mime, `${ref.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'reference'}${ext}`);
  await q(
    `insert into provider_uploads (user_id, file, provider_id, uri, expires_at, url) values ($1,$2,$3,$4,$5,$6)
     on conflict (user_id, file, provider_id) do update set uri = excluded.uri, expires_at = excluded.expires_at, url = excluded.url`,
    [userId, ref.file, provider.id, uploaded.uri, uploaded.expiresAt || null, uploaded.url || null]);
  return { uri: uploaded.uri, url: uploaded.url, file: ref.file };
}

/** The placeholder image used for pricing, uploaded to the provider once per user. */
async function placeholderUri(userId: string, provider: Provider) {
  const file = await ensureQuotePlaceholder();
  const key = `${userId}:${provider.id}:${file}:false`;
  const pending = uploading.get(key);
  if (pending) return (await pending).uri;
  const task = uploadOnce(userId, provider, { file, mime: 'image/png', name: 'placeholder' }, false).finally(() => uploading.delete(key));
  uploading.set(key, task);
  return (await task).uri;
}

/** Upload the photos of the @elements a prompt uses, for providers that take elements natively. */
async function elementInputs(userId: string, provider: Provider, used: { id: string; name: string; description: string; refIds: string[] }[] | undefined, needUrl: boolean): Promise<ElementInput[] | undefined> {
  if (!used?.length) return undefined;
  const out: ElementInput[] = [];
  for (const e of used) {
    const images: Media[] = [];
    for (const refId of e.refIds) images.push(await providerMedia(userId, provider, refId, needUrl));
    out.push({ id: e.id, name: e.name, description: e.description, images });
  }
  return out;
}

const inFlight = new Set<string>();

async function fail(id: string, message: string) {
  await q(`update generations set status = 'failed', error = $2, updated_at = now() where id = $1`, [id, message.slice(0, 2000)]);
  notifyChange(await ownerOf(id));
}

export async function submit(id: string) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const g = await one('select g.*, w.user_id from generations g join workspaces w on w.id = g.workspace_id where g.id = $1', [id]);
    if (!g || g.status !== 'pending' || g.task_id) return;
    const provider = getProvider(g.user_id, g.provider_id);
    const model = await provider.getModel(g.model_id);
    const refs: Record<string, string[]> = {};
    for (const [key, ids] of Object.entries<string[]>(g.resolved_input.refs || {})) {
      if (!ids.length) continue;
      refs[key] = [];
      for (const refId of ids) refs[key].push(await providerUri(g.user_id, provider, refId));
    }
    const task = await provider.create({
      model: g.model_id, modality: g.modality, prompt: g.resolved_input.prompt, promptField: model.promptField,
      settings: g.settings, refs, idempotencyKey: g.idempotency_key,
      elements: await elementInputs(g.user_id, provider, g.resolved_input.elements, provider.id === 'higgsfield'),
    });
    await q(
      `update generations set task_id = $2, status = $3, estimated_cost = $4, cost_unit = $5,
              next_poll_at = now() + interval '3 seconds', updated_at = now() where id = $1`,
      [id, task.taskId, task.state === 'succeeded' ? 'running' : task.state, task.estimatedCost ?? null, provider.unit]);
    notifyChange(g.user_id);
  } catch (error: any) {
    await fail(id, error.message || 'Submission failed');
  } finally {
    inFlight.delete(id);
  }
}

async function capture(g: any, provider: Provider) {
  const result = await provider.task(g.task_id);
  if (result.state === 'failed') return fail(g.id, result.error || 'Generation failed');
  if (result.state !== 'succeeded') {
    const delay = Math.min(3 + g.poll_count, 15);
    await q(
      `update generations set status = $2, poll_count = poll_count + 1, next_poll_at = now() + make_interval(secs => $3), updated_at = now() where id = $1`,
      [g.id, result.state, delay]);
    if (result.state !== g.status) notifyChange(g.user_id);
    return;
  }
  if (!result.assets.length) return fail(g.id, 'The provider finished without returning any files.');
  await q(`update generations set status = 'saving', updated_at = now() where id = $1`, [g.id]);
  const existing = new Set((await q<{ idx: number }>('select idx from assets where generation_id = $1', [g.id])).map(r => r.idx));
  for (let idx = 0; idx < result.assets.length; idx++) {
    if (existing.has(idx)) continue;
    const remote = result.assets[idx];
    const stored = await storeFromUrl(remote.url, remote.mime || (g.modality === 'video' ? 'video/mp4' : 'image/png'));
    await q(
      // Timestamped with the job's submission time so the timeline follows submission order.
      `insert into assets (generation_id, workspace_id, folder_id, idx, kind, file, thumb, mime, width, height, duration, remote_ref, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               (select created_at from generations where id = $1) - ($4::int * interval '1 microsecond'))
       on conflict (generation_id, idx) do nothing`,
      [g.id, g.workspace_id, g.folder_id, idx, stored.kind, stored.file, stored.thumb, stored.mime, stored.width, stored.height, stored.duration, remote.remoteRef || null]);
  }
  await q(`update generations set status = 'succeeded', cost = coalesce($2, estimated_cost), error = null, updated_at = now() where id = $1`, [g.id, result.cost ?? null]);
  notifyChange(g.user_id);
}

async function poll(g: any) {
  if (inFlight.has(g.id)) return;
  inFlight.add(g.id);
  try {
    if (Date.now() - new Date(g.created_at).getTime() > 3 * 3600_000) return await fail(g.id, 'Timed out waiting for the provider.');
    await capture(g, getProvider(g.user_id, g.provider_id));
  } catch (error: any) {
    // Transient errors: back off and retry; give up after many attempts.
    if (g.poll_count > 200) await fail(g.id, error.message);
    else await q(`update generations set poll_count = poll_count + 1, next_poll_at = now() + interval '20 seconds', error = $2 where id = $1`, [g.id, `Retrying: ${error.message}`.slice(0, 500)]);
  } finally {
    inFlight.delete(g.id);
  }
}

export function startWorker() {
  // Submissions interrupted by a restart: SpicyAPI requests carry an idempotency key and are safe to resend;
  // other providers are marked failed so nothing is ever charged twice.
  // Rewrites interrupted by a restart: nothing was charged yet, so they simply run again.
  q(`select distinct batch_group from generations where status = 'enhancing'`)
    .then(rows => { for (const row of rows) enhanceGroup(row.batch_group).catch(() => {}); })
    .catch(error => console.error('worker init', error));
  q(`select id, provider_id from generations where status = 'pending' and task_id is null`).then(rows => {
    for (const row of rows) {
      if (row.provider_id === 'spicyapi') submit(row.id).catch(() => {});
      else fail(row.id, 'Interrupted by a restart before it was submitted. Use Recreate to try again.');
    }
  }).catch(error => console.error('worker init', error));
  const tick = async () => {
    try {
      const due = await q(
        `select g.*, w.user_id from generations g join workspaces w on w.id = g.workspace_id
          where g.status in ('queued','running','saving') and g.task_id is not null and g.next_poll_at <= now()
          order by g.next_poll_at limit 25`);
      await Promise.all(due.map(poll));
    } catch (error) {
      console.error('poll tick failed', error);
    } finally {
      setTimeout(tick, 2000).unref();
    }
  };
  setTimeout(tick, 2000).unref();
}
