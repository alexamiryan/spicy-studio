import { api } from './api';
import { defaultSettings, primaryRefField, remapRefs } from './models';
import { invalidateGallery, keys, queryClient } from './queries';
import { errorText, useStore } from './store';
import type { Asset, Environment, GenerationDetail, Modality, ModelGroup, ModelInfo, Preset, Ref, Workspace } from './types';

export function cachedModel(modelId?: string, modality?: Modality): ModelInfo | undefined {
  if (!modelId) return undefined;
  const lists = modality ? [modality] : (['image', 'video'] as Modality[]);
  for (const m of lists) {
    const data = queryClient.getQueryData<{ providers: ModelGroup[] }>(keys.models(m));
    const found = data?.providers.flatMap(p => p.models).find(x => x.id === modelId);
    if (found) return found;
  }
  return undefined;
}

export async function loadModels(modality: Modality) {
  return queryClient.fetchQuery({
    queryKey: keys.models(modality), staleTime: 60_000,
    queryFn: () => api.get<{ providers: ModelGroup[]; favorites: string[] }>(`/api/models?modality=${modality}`),
  });
}

/** Select a model in the create box, keeping compatible settings and references. */
export function selectModel(model: ModelInfo) {
  const { draft, patchDraft } = useStore.getState();
  patchDraft({
    modality: model.modality,
    models: { ...draft.models, [model.modality]: model.id },
    settings: { ...draft.settings, [model.id]: defaultSettings(model, draft.settings[model.id] || draft.settings[draft.models[model.modality] || ''] || {}) },
    refSlots: remapRefs(draft.refSlots, model),
  });
}

/** Load a past generation's prompt, model, settings, refs and folder back into the create box. */
export async function recreate(generationId: string, source?: Asset) {
  const { toast, patchDraft, draft, set } = useStore.getState();
  set({ recreatedFrom: source ?? null });
  try {
    const g = await api.get<GenerationDetail>(`/api/generations/${generationId}`);
    const byId = new Map(g.refs.map(r => [r.id, r]));
    let missing = 0;
    const refSlots: Record<string, Ref[]> = {};
    for (const [key, ids] of Object.entries(g.refSlots || {})) {
      refSlots[key] = ids.map(id => byId.get(id)).filter((r): r is Ref => { if (!r) missing++; return Boolean(r); });
    }
    await loadModels(g.modality).catch(() => null);
    const model = cachedModel(g.modelId, g.modality);
    markActive(g.modality, undefined);
    patchDraft({
      modality: g.modality,
      models: { ...draft.models, [g.modality]: g.modelId },
      settings: { ...draft.settings, [g.modelId]: model ? defaultSettings(model, g.settings) : g.settings },
      prompt: g.prompt,
      refSlots: model ? remapRefs(refSlots, model) : refSlots,
      folderId: folderFor(g.folderId),
      batch: g.batchSize || 1,
    });
    set({ viewer: null, createOpen: true });
    if (!model) toast(`${g.modelName} is not available right now. Settings were loaded anyway.`, 'error');
    else if (missing) toast(`${missing} reference${missing > 1 ? 's were' : ' was'} deleted and could not be restored.`, 'error');
    else toast('Loaded into the create box');
  } catch (error) {
    toast(errorText(error), 'error');
  }
}

/**
 * The folder new generations should go to when the create box is (re)loaded: the folder open in the
 * sidebar wins (Unsorted = no folder); otherwise the loaded result's or preset's own folder.
 */
function folderFor(loaded: string | null): string | null {
  const { view, folder } = useStore.getState();
  if (view === 'folders' && folder) return folder === 'unsorted' ? null : folder;
  return loaded;
}

/** Add refs to the create box: to the given field, or the current model's main reference field. */
export function addRefsToDraft(refs: Ref[], fieldKey?: string) {
  const { draft, patchDraft, toast } = useStore.getState();
  const model = cachedModel(draft.models[draft.modality], draft.modality);
  const field = fieldKey ? model?.refFields.find(f => f.key === fieldKey) : primaryRefField(model) || model?.refFields.find(f => refs.every(r => r.kind === f.kind));
  if (!model || !field) {
    toast(model ? `${model.name} does not take reference images.` : 'Pick a model first.', 'error');
    return false;
  }
  const current = draft.refSlots[field.key] || [];
  const fitting = refs.filter(r => r.kind === field.kind && !current.some(c => c.id === r.id));
  const next = [...current, ...fitting];
  if (next.length > field.max) toast(`${field.label} takes up to ${field.max}, so ${next.length - field.max} weren't attached. They're all saved in References.`, 'error');
  patchDraft({ refSlots: { ...draft.refSlots, [field.key]: next.slice(0, field.max) } });
  return true;
}

export async function assetToRef(asset: Asset) {
  const { toast, set } = useStore.getState();
  try {
    const ref = await api.post<Ref>('/api/refs/from-asset', { assetId: asset.id });
    if (addRefsToDraft([ref])) {
      toast('Added as reference');
      set({ viewer: null });
    }
    queryClient.invalidateQueries({ queryKey: keys.refs(asset.workspaceId) });
  } catch (error) {
    toast(errorText(error), 'error');
  }
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

export async function downloadAsset(asset: Asset) {
  const url = `/api/assets/${asset.id}/download`;
  // Phones: the share sheet offers "Save Image/Video" straight to the photo library.
  if (isTouch() && 'share' in navigator && 'canShare' in navigator) {
    try {
      const blob = await (await fetch(url)).blob();
      const ext = asset.mime.split('/')[1]?.replace('quicktime', 'mov').replace('jpeg', 'jpg') || 'bin';
      const file = new File([blob], `${asset.modelName.replace(/\W+/g, '-').toLowerCase()}-${asset.id.slice(0, 6)}.${ext}`, { type: asset.mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "Save": copy a result into the workspace's save folder (e.g. on the NAS). */
export async function saveAsset(asset: Asset): Promise<boolean> {
  const { toast } = useStore.getState();
  try {
    // No success toast: the Save button / card icon turning green confirms it without covering the UI.
    await api.post<{ path: string }>(`/api/assets/${asset.id}/export`);
    // The viewer holds a snapshot of the list; mark the item saved there too.
    const { viewer, set } = useStore.getState();
    if (viewer) set({ viewer: { ...viewer, list: viewer.list.map(a => (a.id === asset.id ? { ...a, exported: true } : a)) } });
    invalidateGallery(asset.workspaceId);
    return true;
  } catch (error) {
    toast(errorText(error), 'error');
    return false;
  }
}

export async function moveAssets(workspaceId: string, assetIds: string[], folderId: string | null, folderName?: string) {
  const { toast, clearSelection } = useStore.getState();
  try {
    const { moved } = await api.post<{ moved: number }>('/api/assets/move', { assetIds, folderId });
    toast(`Moved ${moved} item${moved === 1 ? '' : 's'} to ${folderName || 'Unsorted'}`);
    clearSelection();
    invalidateGallery(workspaceId);
  } catch (error) {
    toast(errorText(error), 'error');
  }
}

export async function deleteAssets(workspaceId: string, assetIds: string[]) {
  const { toast, clearSelection, set } = useStore.getState();
  if (!confirm(`Delete ${assetIds.length === 1 ? 'this item' : `${assetIds.length} items`}? This cannot be undone.`)) return false;
  try {
    await api.post('/api/assets/delete', { assetIds });
    clearSelection();
    set({ viewer: null });
    invalidateGallery(workspaceId);
    return true;
  } catch (error) {
    toast(errorText(error), 'error');
    return false;
  }
}

export async function createFolder(workspaceId: string, name: string) {
  const folder = await api.post<{ id: string; name: string }>('/api/folders', { workspaceId, name });
  queryClient.invalidateQueries({ queryKey: keys.folders(workspaceId) });
  return folder;
}

const UPLOAD_BATCH = 4;

/**
 * Upload many files a few at a time (the server takes a limited number per request, and big selections
 * of large photos shouldn't ride on one request). A failed batch is retried file by file, so one bad
 * file doesn't sink the rest; failures are reported at the end. Shows progress in the upload pill.
 */
async function uploadInBatches<T>(files: File[] | FileList, url: string, label: string): Promise<T[]> {
  const list = Array.from(files);
  const { set, toast } = useStore.getState();
  const out: T[] = [];
  const failed: string[] = [];
  let firstError = '';
  const send = (batch: File[]) => {
    const form = new FormData();
    for (const file of batch) form.append('file', file, file.name);
    return api.post<T[]>(url, form);
  };
  if (list.length > 1) set({ upload: { done: 0, total: list.length, label } });
  try {
    for (let i = 0; i < list.length; i += UPLOAD_BATCH) {
      const batch = list.slice(i, i + UPLOAD_BATCH);
      try { out.push(...await send(batch)); }
      catch (error) {
        if (batch.length === 1) { failed.push(batch[0].name); firstError ||= errorText(error); }
        else for (const file of batch) {
          try { out.push(...await send([file])); }
          catch (single) { failed.push(file.name); firstError ||= errorText(single); }
        }
      }
      if (list.length > 1) set({ upload: { done: Math.min(i + UPLOAD_BATCH, list.length), total: list.length, label } });
    }
  } finally {
    set({ upload: null });
  }
  if (failed.length) {
    const names = failed.slice(0, 3).join(', ') + (failed.length > 3 ? ` and ${failed.length - 3} more` : '');
    toast(list.length === 1 ? firstError : `${failed.length} of ${list.length} files were not uploaded (${names}): ${firstError}`, 'error');
  }
  return out;
}

export async function uploadRefs(workspaceId: string, files: File[] | FileList, modelRef = false): Promise<Ref[]> {
  const refs = await uploadInBatches<Ref>(files, `/api/refs/upload?workspaceId=${workspaceId}${modelRef ? '&modelRef=1' : ''}`,
    modelRef ? 'Uploading model refs' : 'Uploading');
  queryClient.invalidateQueries({ queryKey: keys.refs(workspaceId) });
  return refs;
}

/** Move workspace references between Model refs, Uploads and the environment library. */
export async function moveRefs(workspaceId: string, ids: string[], to: 'model' | 'uploads' | 'environments') {
  const action = to === 'model' ? 'model' : to === 'uploads' ? 'unmodel' : 'environments';
  const result = await api.post<{ count: number; skipped?: number }>('/api/refs/bulk', { ids, action });
  queryClient.invalidateQueries({ queryKey: keys.refs(workspaceId) });
  if (to === 'environments') queryClient.invalidateQueries({ queryKey: keys.environments });
  return result;
}

/** Move environment photos into this workspace's Model refs or Uploads (out of the shared library). */
export async function moveEnvironments(workspaceId: string, ids: string[], to: 'model' | 'uploads') {
  const result = await api.post<{ count: number }>('/api/environments/move', { workspaceId, ids, to });
  queryClient.invalidateQueries({ queryKey: keys.environments });
  queryClient.invalidateQueries({ queryKey: keys.refs(workspaceId) });
  return result;
}

/** Add generated photos to the environment library. */
export async function assetsToEnvironments(assetIds: string[]) {
  const created = await api.post<Environment[]>('/api/environments/from-assets', { assetIds });
  queryClient.invalidateQueries({ queryKey: keys.environments });
  return created;
}

export async function addToEnvironments(asset: Asset) {
  const { toast } = useStore.getState();
  try {
    await assetsToEnvironments([asset.id]);
    toast('Added to Environments', 'ok');
  } catch (error) {
    toast(errorText(error), 'error');
  }
}

/** The input a photo should go into to animate it: a start frame if the model has one, else its main image input. */
function startFrameField(model: ModelInfo) {
  const images = model.refFields.filter(f => f.kind === 'image');
  return images.find(f => f.max === 1 && /start|first|^image_url$|^image$/i.test(f.key))
    || images.find(f => f.max === 1)
    || primaryRefField(model)
    || images[0];
}

/**
 * "Animate": load this photo into the create box as the start frame of a video, using the
 * workspace's last video generation (model, prompt, settings, references, batch, folder).
 */
export async function animateAsset(asset: Asset) {
  const { toast, set, patchDraft, draft } = useStore.getState();
  try {
    const [ref, last] = await Promise.all([
      api.post<Ref>('/api/refs/from-asset', { assetId: asset.id }),
      api.get<{ id: string } | null>(`/api/generations/last?workspaceId=${asset.workspaceId}&modality=video`),
    ]);
    const detail = last ? await api.get<GenerationDetail>(`/api/generations/${last.id}`) : null;
    await loadModels('video').catch(() => null);
    const workspace = queryClient.getQueryData<Workspace[]>(keys.workspaces)?.find(w => w.id === asset.workspaceId);
    const modelId = [detail?.modelId, draft.models.video, workspace?.prefs.videoModel].find(id => id && cachedModel(id, 'video'));
    const model = modelId ? cachedModel(modelId, 'video') : undefined;
    if (!model) {
      patchDraft({ modality: 'video' });
      set({ viewer: null, createOpen: true });
      toast('Pick a video model first; your photo can then be added as the start frame.', 'error');
      return;
    }

    // Previous references, per input, then the photo into the start frame.
    const byId = new Map((detail?.refs || []).map(r => [r.id, r]));
    const previous: Record<string, Ref[]> = {};
    if (detail && detail.modelId === model.id) {
      for (const [key, ids] of Object.entries(detail.refSlots || {})) previous[key] = ids.map(id => byId.get(id)).filter((r): r is Ref => Boolean(r));
    }
    const slots = remapRefs(previous, model);
    // Follow the last video's setup: if it worked from references (not a start frame), put the photo first
    // among them (image 1), since some models refuse a start frame combined with references.
    const frame = startFrameField(model);
    const main = primaryRefField(model) || model.refFields.find(f => f.kind === 'image' && f.max > 1);
    const usedFrame = Boolean(frame && (slots[frame.key] || []).length);
    const usedRefs = Boolean(main && main !== frame && (slots[main.key] || []).length);
    const field = usedRefs && !usedFrame ? main : frame;
    if (field) slots[field.key] = field.max === 1 ? [ref] : [ref, ...(slots[field.key] || []).filter(r => r.id !== ref.id)].slice(0, field.max);

    markActive('video', undefined);
    patchDraft({
      modality: 'video',
      models: { ...draft.models, video: model.id },
      settings: { ...draft.settings, [model.id]: defaultSettings(model, detail?.modelId === model.id ? detail.settings : draft.settings[model.id] || {}) },
      prompt: detail?.prompt ?? draft.prompt,
      refSlots: slots,
      batch: detail?.batchSize || draft.batch,
      folderId: folderFor(detail ? detail.folderId : draft.folderId),
    });
    set({ viewer: null, createOpen: true });
    toast(detail ? `Ready to animate with ${model.name} (last video settings)` : `Ready to animate with ${model.name}`);
    queryClient.invalidateQueries({ queryKey: keys.refs(asset.workspaceId) });
  } catch (error) {
    toast(errorText(error), 'error');
  }
}

/** Resubmit a failed generation with the same inputs (the failed card is replaced). */
export async function retryGeneration(id: string, workspaceId: string) {
  try {
    await api.post(`/api/generations/${id}/retry`);
    queryClient.invalidateQueries({ queryKey: keys.active(workspaceId) });
    return true;
  } catch (error) {
    useStore.getState().toast(errorText(error), 'error');
    return false;
  }
}

/** Remove a failed (or stuck) generation card. */
export async function dismissGeneration(id: string, workspaceId: string) {
  await api.del(`/api/generations/${id}`).catch(() => {});
  queryClient.invalidateQueries({ queryKey: keys.active(workspaceId) });
}

// ---- "seen" tracking: results opened in the viewer lose their "new" outline in the grid.
const seenQueue = new Set<string>();
let seenTimer: number | undefined;

/** Mark a result as seen. Updates the grid immediately; the server is told in small batches. */
export function markSeen(asset: Asset) {
  if (asset.seen || seenQueue.has(asset.id)) return;
  seenQueue.add(asset.id);
  queryClient.setQueriesData<{ pages: { items: Asset[] }[] }>({ queryKey: keys.assets(asset.workspaceId) }, data => data && {
    ...data, pages: data.pages.map(p => ({ ...p, items: p.items.map(a => (a.id === asset.id ? { ...a, seen: true } : a)) })),
  });
  const { viewer, set } = useStore.getState();
  if (viewer?.list.some(a => a.id === asset.id && !a.seen)) {
    set({ viewer: { ...viewer, list: viewer.list.map(a => (a.id === asset.id ? { ...a, seen: true } : a)) } });
  }
  window.clearTimeout(seenTimer);
  seenTimer = window.setTimeout(() => {
    const assetIds = [...seenQueue];
    seenQueue.clear();
    api.post('/api/assets/seen', { assetIds }).catch(() => {});
  }, 1200);
}

/** File a generated photo under Model refs (creating its reference if needed). */
export async function addToModelRefs(asset: Asset) {
  const { toast } = useStore.getState();
  try {
    await api.post<Ref>('/api/refs/from-asset', { assetId: asset.id, modelRef: true });
    queryClient.invalidateQueries({ queryKey: keys.refs(asset.workspaceId) });
    toast('Added to Model refs', 'ok');
  } catch (error) {
    toast(errorText(error), 'error');
  }
}

/** Upload photos to the environment library (shared by all workspaces). */
export async function uploadEnvironments(files: File[] | FileList): Promise<Environment[]> {
  const created = await uploadInBatches<Environment>(files, '/api/environments/upload', 'Uploading environments');
  queryClient.invalidateQueries({ queryKey: keys.environments });
  return created;
}

/** References in this workspace for environment photos (created once, then reused), in the given order. */
export async function environmentRefs(workspaceId: string, ids: string[]): Promise<Ref[]> {
  if (!ids.length) return [];
  const refs = await api.post<Ref[]>('/api/environments/use', { workspaceId, ids });
  queryClient.invalidateQueries({ queryKey: keys.refs(workspaceId) });
  return refs;
}

// ---------------------------------------------------------------- presets

/** The create box's current state for one modality, as stored in a preset. */
export function presetState(modality: Modality) {
  const { draft } = useStore.getState();
  const modelId = draft.models[modality];
  if (!modelId) throw new Error('Pick a model first.');
  return {
    modelId, prompt: draft.prompt, settings: draft.settings[modelId] || {},
    refSlots: Object.fromEntries(Object.entries(draft.refSlots).map(([key, refs]) => [key, refs.map(r => r.id)])),
    folderId: draft.folderId, batch: draft.batch,
  };
}

const refreshPresets = (workspaceId: string) => queryClient.invalidateQueries({ queryKey: keys.presets(workspaceId) });
/** JSON with sorted keys, so the same state always compares equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => (value as any)[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The create box state as compared with a loaded preset (empty reference inputs don't count). */
export function presetSnapshot(modality: Modality) {
  try {
    const state = presetState(modality);
    return stableJson({ ...state, refSlots: Object.fromEntries(Object.entries(state.refSlots).filter(([, ids]) => ids.length)) });
  } catch { return ''; }
}

/** Remember which preset the box holds now (and its exact state), or forget it. */
function markActive(modality: Modality, id: string | undefined) {
  const { activePreset, set } = useStore.getState();
  set({ activePreset: { ...activePreset, [modality]: id ? { id, snapshot: presetSnapshot(modality) } : undefined } });
}

export async function savePreset(workspaceId: string, modality: Modality, name: string) {
  const preset = await api.post<Preset>('/api/presets', { workspaceId, modality, name, ...presetState(modality) });
  markActive(modality, preset.id);
  refreshPresets(workspaceId);
  return preset;
}

/** Replace a preset's saved state with what's in the create box now. */
export async function updatePreset(preset: Preset) {
  const updated = await api.patch<Preset>(`/api/presets/${preset.id}`, { state: presetState(preset.modality) });
  markActive(preset.modality, preset.id);
  refreshPresets(preset.workspaceId);
  return updated;
}

export async function renamePreset(preset: Preset, name: string) {
  await api.patch(`/api/presets/${preset.id}`, { name });
  refreshPresets(preset.workspaceId);
}

export async function deletePreset(preset: Preset) {
  await api.del(`/api/presets/${preset.id}`);
  if (useStore.getState().activePreset[preset.modality]?.id === preset.id) markActive(preset.modality, undefined);
  refreshPresets(preset.workspaceId);
}

/** Load a preset into the create box (like Recreate, without having to find an old result). */
export async function loadPreset(preset: Preset) {
  const { toast, patchDraft, draft } = useStore.getState();
  const byId = new Map(preset.refs.map(r => [r.id, r]));
  let missing = 0;
  const refSlots: Record<string, Ref[]> = {};
  for (const [key, ids] of Object.entries(preset.refSlots || {})) {
    refSlots[key] = ids.map(id => byId.get(id)).filter((r): r is Ref => { if (!r) missing++; return Boolean(r); });
  }
  await loadModels(preset.modality).catch(() => null);
  const model = cachedModel(preset.modelId, preset.modality);
  patchDraft({
    modality: preset.modality,
    models: { ...draft.models, [preset.modality]: preset.modelId },
    settings: { ...draft.settings, [preset.modelId]: model ? defaultSettings(model, preset.settings) : preset.settings },
    prompt: preset.prompt,
    refSlots: model ? remapRefs(refSlots, model) : refSlots,
    folderId: folderFor(preset.folderId),
    batch: preset.batch || 1,
  });
  markActive(preset.modality, preset.id);
  api.post(`/api/presets/${preset.id}/used`).then(() => refreshPresets(preset.workspaceId)).catch(() => {});
  if (!model) toast(`${preset.modelId.split(':').slice(1).join(':')} is not available right now. The rest was loaded.`, 'error');
  else if (missing) toast(`Loaded "${preset.name}". ${missing} reference${missing > 1 ? 's were' : ' was'} deleted since it was saved.`, 'error');
  else toast(`Loaded "${preset.name}"`);
}
