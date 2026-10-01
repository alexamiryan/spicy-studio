const media = (file?: string | null) => (file ? `/media/${file}` : null);

export function refDto(r: any) {
  return {
    id: r.id, workspaceId: r.workspace_id, kind: r.kind, name: r.name, mime: r.mime,
    url: media(r.file), thumbUrl: media(r.thumb) || (r.kind === 'image' ? media(r.file) : null),
    width: r.width, height: r.height, isModelRef: r.is_model_ref, sourceAssetId: r.source_asset_id, sourceEnvironmentId: r.source_environment_id, createdAt: r.created_at,
  };
}

export function environmentDto(e: any) {
  return {
    id: e.id, kind: e.kind, name: e.name, mime: e.mime, url: media(e.file),
    thumbUrl: media(e.thumb) || media(e.file), width: e.width, height: e.height, createdAt: e.created_at,
  };
}

export function assetDto(a: any) {
  return {
    id: a.id, generationId: a.generation_id, workspaceId: a.workspace_id, folderId: a.folder_id, index: a.idx,
    kind: a.kind, mime: a.mime, url: media(a.file), thumbUrl: media(a.thumb) || (a.kind === 'image' ? media(a.file) : null),
    width: a.width, height: a.height, duration: a.duration, exported: (a.exported_paths || []).length > 0, seen: Boolean(a.seen_at),
    createdAt: a.created_at, prompt: a.prompt, modelName: a.model_name,
    modelId: a.provider_id && a.model_id ? `${a.provider_id}:${a.model_id}` : undefined, providerId: a.provider_id,
  };
}

export function generationDto(g: any) {
  return {
    id: g.id, workspaceId: g.workspace_id, folderId: g.folder_id, providerId: g.provider_id,
    modelId: `${g.provider_id}:${g.model_id}`, modelName: g.model_name, modality: g.modality,
    prompt: g.prompt, settings: g.settings, refSlots: g.ref_slots, batchGroup: g.batch_group, batchSize: g.batch_size,
    status: g.status, error: g.error, estimatedCost: g.estimated_cost, cost: g.cost, costUnit: g.cost_unit,
    createdAt: g.created_at, updatedAt: g.updated_at,
  };
}

export function workspaceDto(w: any) {
  return { id: w.id, name: w.name, imageExportDir: w.image_export_dir, videoExportDir: w.video_export_dir, prefs: w.prefs || {}, createdAt: w.created_at };
}

export function encodeCursor(ts: string, id: string) { return Buffer.from(`${ts}|${id}`).toString('base64url'); }

export function decodeCursor(cursor?: string): [string, string] | null {
  if (!cursor) return null;
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!ts || !/^[0-9a-f-]{36}$/.test(id || '')) return null;
  return [ts, id];
}
