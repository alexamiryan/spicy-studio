import { ProviderError, type ModelInfo } from '../providers/types.js';

// Pure helpers for the agent tools (no database), so they can be unit tested.

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Find one item by id or name: exact id, then exact name (ignoring case), then a unique partial name match.
 * Agents mostly know names ("Mia", "Beach shoot"), not ids. Errors list what exists so they can correct.
 */
export function pickOne<T extends { id: string; name: string }>(items: T[], value: unknown, what: string): T {
  const wanted = String(value ?? '').trim();
  if (!wanted) throw new ProviderError(`Say which ${what}: ${names(items)}.`, 400);
  const byId = items.find(i => i.id === wanted);
  if (byId) return byId;
  const exact = items.filter(i => norm(i.name) === norm(wanted));
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : items.filter(i => norm(i.name).includes(norm(wanted)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const listed = partial.slice(0, 25).map(i => `"${i.name}" (${i.id})`).join(', ');
    throw new ProviderError(`"${wanted}" matches several ${what}s: ${listed}. Use the full name or the id.`, 400);
  }
  throw new ProviderError(`No ${what} called "${wanted}". ${items.length ? `Choose from: ${names(items)}.` : `There are none yet.`}`, 404);
}

const names = (items: { name: string }[]) =>
  items.slice(0, 25).map(i => `"${i.name}"`).join(', ') + (items.length > 25 ? `, … (${items.length - 25} more)` : '') || 'none';

/** One line per model for list_models. */
export function modelSummary(m: ModelInfo, extra: { provider: string; favorite?: boolean }) {
  return {
    id: m.id, name: m.name, provider: extra.provider,
    ...(m.price ? { price: m.price } : {}),
    ...(m.mature !== undefined ? { uncensored: m.mature } : {}),
    ...(extra.favorite ? { favorite: true } : {}),
    references: m.refFields.map(f => `${f.key} (${f.kind}${f.max > 1 ? ` ×${f.max}` : ''}${f.required ? ', required' : ''})`),
  };
}

/** Everything an agent needs to call generate with a model: settings with their options, and reference inputs. */
export function modelDetails(m: ModelInfo, provider: string) {
  return {
    id: m.id, name: m.name, provider, modality: m.modality, description: m.description, price: m.price,
    ...(m.mature !== undefined ? { uncensored: m.mature } : {}),
    settings: m.fields.map(f => ({
      key: f.key, label: f.label, type: f.type,
      ...(f.options ? { options: f.options } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
      ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}),
      ...(f.unit ? { unit: f.unit } : {}), ...(f.required ? { required: true } : {}),
      ...(f.description ? { description: f.description } : {}),
    })),
    references: m.refFields.map(f => ({
      key: f.key, label: f.label, kind: f.kind, max: f.max, required: f.required, ...(f.primary ? { primary: true } : {}),
    })),
    ...(m.nativeElements ? { elements: `Mention elements as @Name in the prompt (up to ${m.nativeElements.max}).` } : {}),
  };
}

export interface GenerateArgs {
  model?: string; prompt?: string; settings?: Record<string, unknown>; references?: unknown;
  folder?: string | null; batch?: number;
}
export interface PresetState { modelId: string; prompt: string; settings: Record<string, unknown>; refSlots: Record<string, string[]>; folderId: string | null; batch: number }

/** A preset as the starting point; whatever the agent passes explicitly wins (settings merge key by key). */
export function mergePreset(preset: PresetState | null, args: GenerateArgs) {
  return {
    model: args.model ?? preset?.modelId,
    prompt: args.prompt ?? preset?.prompt ?? '',
    settings: { ...(preset?.settings || {}), ...(args.settings || {}) },
    references: args.references ?? null,
    presetRefs: preset?.refSlots || {},
    folder: args.folder !== undefined ? args.folder : null,
    presetFolderId: preset?.folderId ?? null,
    batch: args.batch ?? preset?.batch ?? 1,
  };
}

/**
 * References as the agent passed them: `{field: [names or ids]}`, or a plain list for the model's main
 * reference input. Returns field → wanted values.
 */
export function referenceSlots(value: unknown, model: Pick<ModelInfo, 'refFields'>): Record<string, string[]> {
  if (value == null) return {};
  const list = (v: unknown) => (Array.isArray(v) ? v : [v]).map(x => String(x ?? '').trim()).filter(Boolean);
  if (Array.isArray(value) || typeof value === 'string') {
    const field = model.refFields.find(f => f.primary) || model.refFields.find(f => f.kind === 'image');
    if (!field) throw new ProviderError('This model takes no references.', 400);
    return { [field.key]: list(value) };
  }
  if (typeof value !== 'object') throw new ProviderError('references must be a list, or an object like {"field": ["name", …]}.', 400);
  const out: Record<string, string[]> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!model.refFields.some(f => f.key === key)) {
      throw new ProviderError(`Unknown reference input "${key}". This model takes: ${model.refFields.map(f => f.key).join(', ') || 'none'}.`, 400);
    }
    out[key] = list(v);
  }
  return out;
}

export const clampWait = (value: unknown, max = 300) => Math.min(Math.max(Math.round(Number(value) || 0), 0), max);
