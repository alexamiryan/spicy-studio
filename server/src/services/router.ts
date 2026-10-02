import { one, q } from '../db.js';
import { providersFor } from '../providers/registry.js';
import { ProviderError, type Cost, type Modality, type ModelField, type ModelInfo, type Provider, type RefField } from '../providers/types.js';
import { getProviderRow } from './providerSettings.js';

/**
 * Auto router. The same model is often offered by several providers under different names ("Seedream 4.5"
 * on Higgsfield, "Seedream 4.5 · Standard"/"· Edit" on PoYo…). Models are grouped into families by name;
 * a user picks families in Settings and gets one "Auto" model per family. On generate, the create box is
 * translated to every provider's version of the model that can take its inputs, each is priced, and the
 * cheapest one the user's balance covers is used.
 */

export const AUTO = 'auto';

// Variants that do something other than plain generation from prompt + references are never routed.
const SPECIAL = /motion control|layer decomposition|extend|upscal|remove|background|lip ?sync|avatar|animate|outpaint|swap|dubbing|voice|reframe|edit video|video to video|keyframes|first last|character|talking|foley|analy[sz]e|deflicker|topaz|depth|clipify|genjutsu|preset|marketing|multiplier|draw to/i;
// Words that don't change which model it is ("Wan 3.0 Spicy" is Wan 3.0, uncensored).
const NOISE = /\b(video|image|api|model|google|bytedance|openai|alibaba|kuaishou|minimax hailuo|spicy|uncensored|nsfw)\b/g;

/**
 * Whether a model version is uncensored: the user's own mark wins, then what the provider reports
 * (SpicyAPI `mature`, PoYo's "Uncensored" tag), then the name. Exported for tests.
 */
export function isUncensored(model: Pick<ModelInfo, 'id' | 'name' | 'model' | 'mature'>, marks: Record<string, boolean> = {}): boolean {
  if (typeof marks[model.id] === 'boolean') return marks[model.id];
  if (typeof model.mature === 'boolean') return model.mature;
  return /\bspicy\b|uncensored|nsfw/i.test(`${model.name} ${model.model}`);
}

/** Family name of a model (provider-independent), or null when it isn't routable. Exported for tests. */
export function familyName(model: Pick<ModelInfo, 'name'>): string | null {
  if (SPECIAL.test(model.name)) return null;
  const base = model.name.split(' · ')[0].toLowerCase()
    .replace(NOISE, ' ')
    .replace(/\bv(\d)/g, '$1') // "Kling v3" = "Kling 3"
    .replace(/(\d)\.0\b/g, '$1') // "3.0" = "3"
    .replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base || null;
}

export const familyKey = (modality: Modality, name: string, uncensored = false) =>
  `${modality}.${name.replace(/[^a-z0-9.]+/g, '-')}${uncensored ? '.uncensored' : ''}`;

interface Candidate { provider: Provider; model: ModelInfo }
export interface Family { key: string; name: string; modality: Modality; uncensored: boolean; candidates: Candidate[] }

/**
 * All routable families for a user's connected providers (any number of providers). Uncensored and
 * regular versions of a model are separate families, so an Auto model never mixes the two.
 */
export async function families(userId: string): Promise<Map<string, Family>> {
  const out = new Map<string, Family>();
  const { marks } = await getRouterSettings(userId);
  for (const provider of providersFor(userId)) {
    if (provider.id === 'mock' && process.env.MOCK_PROVIDER !== '1') continue;
    const row = await getProviderRow(userId, provider.id);
    if (!row.enabled || !(await provider.configured())) continue;
    for (const modality of ['image', 'video'] as const) {
      let models: ModelInfo[] = [];
      try { models = await provider.listModels(modality); } catch { continue; }
      for (const model of models) {
        if (!model.available) continue;
        const name = familyName(model);
        if (!name) continue;
        const uncensored = isUncensored(model, marks);
        const key = familyKey(modality, name, uncensored);
        const label = (n: string) => (uncensored ? `${n} · Uncensored` : n);
        const family = out.get(key) || { key, name: label(displayName(model)), modality, uncensored, candidates: [] };
        if (label(displayName(model)).length < family.name.length) family.name = label(displayName(model));
        family.candidates.push({ provider, model });
        out.set(key, family);
      }
    }
  }
  return out;
}

const displayName = (model: ModelInfo) => {
  // "Seedance 2.5 Spicy" → "Seedance 2.5": the family's " · Uncensored" suffix says it instead.
  const base = model.name.split(' · ')[0].replace(/\s+(spicy|uncensored|nsfw)\b/gi, '').trim();
  const short = base.replace(/[\s-]+(Video|Image)$/i, '').trim();
  return short.length > 2 ? short : base; // "Wan 2.6 Video" → "Wan 2.6", but "Z Image" stays
};

// ---------------------------------------------------------------- the Auto model's inputs and settings

const RATIO = /^\d+(\.\d+)?:\d+(\.\d+)?$/;
/** A resolution option as a height in pixels ("720p", "2K"…), or -1. */
const resRank = (v: unknown) => {
  const s = String(v).toLowerCase();
  const p = /^(\d{3,4})p$/.exec(s);
  if (p) return Number(p[1]);
  const k = /^(\d)k$/.exec(s);
  return k ? Number(k[1]) * 1024 : -1;
};

const isAspect = (f: ModelField) => f.type === 'enum' && /aspect|ratio|size/i.test(f.key) && (f.options || []).some(o => RATIO.test(String(o)));
const isResolution = (f: ModelField) => f.type === 'enum' && /resolution|quality/i.test(f.key) && (f.options || []).some(o => resRank(o) >= 0);
const isDuration = (f: ModelField) => /duration/i.test(f.key) && (f.type === 'enum' || f.type === 'integer' || f.type === 'number');
const isAudio = (f: ModelField) => f.type === 'boolean' && /^(sound|generate_audio|audio|with_audio)$/i.test(f.key);

/** The model's reference inputs by role. Exported for tests. */
export function refRoles(model: Pick<ModelInfo, 'refFields'>) {
  const images = model.refFields.filter(f => f.kind === 'image' && !/mask|end|last/i.test(f.key));
  const start = images.find(f => f.max === 1 && /start|first|^image_url$|^image$/i.test(f.key));
  return {
    images: images.find(f => f.primary) || images.find(f => f.max > 1 && f !== start) || (start ? undefined : images[0]),
    start,
    end: model.refFields.find(f => f.kind === 'image' && f.max === 1 && /end|last/i.test(f.key)),
    videos: model.refFields.find(f => f.kind === 'video'),
    audio: model.refFields.find(f => f.kind === 'audio'),
  };
}

const ROLE_FIELDS: Record<string, Omit<RefField, 'max'>> = {
  images: { key: 'images', label: 'References', kind: 'image', required: false, primary: true },
  start: { key: 'start', label: 'Start frame', kind: 'image', required: false },
  end: { key: 'end', label: 'End frame', kind: 'image', required: false },
  videos: { key: 'videos', label: 'Reference videos', kind: 'video', required: false },
  audio: { key: 'audio', label: 'Audio', kind: 'audio', required: false },
};

/** The Auto model shown in the picker: the settings and inputs its providers have in common terms. */
export function autoModel(family: Family): ModelInfo {
  const models = family.candidates.map(c => c.model);
  const fields: ModelField[] = [];
  const union = (pick: (f: ModelField) => boolean) => models.flatMap(m => m.fields.filter(pick));
  const aspects = [...new Set(union(isAspect).flatMap(f => (f.options || []).filter(o => RATIO.test(String(o))).map(String)))];
  if (aspects.length) fields.push({ key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', options: aspects, default: aspects.includes('9:16') ? '9:16' : aspects[0] });
  const resolutions = [...new Set(union(isResolution).flatMap(f => (f.options || []).filter(o => resRank(o) >= 0).map(o => String(o).toLowerCase())))]
    .sort((a, b) => resRank(a) - resRank(b));
  if (resolutions.length) fields.push({ key: 'resolution', label: 'Resolution', type: 'enum', options: resolutions, default: resolutions.includes('720p') ? '720p' : resolutions[0] });
  if (family.modality === 'video') {
    const durations = union(isDuration);
    if (durations.length) {
      const options = [...new Set(durations.flatMap(f => f.options?.length ? f.options.map(Number) : [f.min, f.max].filter(n => typeof n === 'number') as number[]))]
        .filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
      const from = Math.min(...options), to = Math.max(...options);
      const choices = to - from <= 30 ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : options;
      fields.push({ key: 'duration', label: 'Duration', type: 'enum', unit: 's', options: choices, default: choices.includes(5) ? 5 : choices[0] });
    }
    if (union(isAudio).length) fields.push({ key: 'audio', label: 'Audio', type: 'boolean', default: union(isAudio).some(f => f.default === true) });
  }
  const refFields: RefField[] = [];
  for (const role of ['images', 'start', 'end', 'videos', 'audio'] as const) {
    const max = Math.max(0, ...models.map(m => refRoles(m)[role]?.max || 0));
    if (max) refFields.push({ ...ROLE_FIELDS[role], max });
  }
  const providers = [...new Set(family.candidates.map(c => c.provider.name))];
  return {
    id: `${AUTO}:${family.key}`, providerId: AUTO, model: family.key, name: family.name, vendor: providers.join(' / '),
    modality: family.modality, promptField: 'prompt', fields, refFields, available: true,
    description: `${family.uncensored ? 'Uncensored versions only. ' : ''}Cheapest of ${providers.join(', ')} with enough balance`,
  };
}

// ---------------------------------------------------------------- translating the create box to a provider's model

const nearest = <T>(options: T[], score: (o: T) => number) => options.reduce((best, o) => (score(o) < score(best) ? o : best), options[0]);
const ratioValue = (v: unknown) => { const [w, h] = String(v).split(':').map(Number); return w / h; };

/** Settings for a concrete model from the Auto model's settings (closest match when options differ). Exported for tests. */
export function translateSettings(model: ModelInfo, auto: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of model.fields) {
    if (isAspect(f) && auto.aspect_ratio !== undefined) {
      const ratios = (f.options || []).filter(o => RATIO.test(String(o)));
      out[f.key] = ratios.find(o => String(o) === String(auto.aspect_ratio))
        ?? nearest(ratios, o => Math.abs(Math.log(ratioValue(o) / ratioValue(auto.aspect_ratio))));
    } else if (isResolution(f) && auto.resolution !== undefined) {
      const options = (f.options || []).filter(o => resRank(o) >= 0);
      out[f.key] = options.find(o => String(o).toLowerCase() === String(auto.resolution).toLowerCase())
        // Closest height; on a tie the lower (cheaper) one.
        ?? nearest(options, o => Math.abs(resRank(o) - resRank(auto.resolution)) + resRank(o) / 1e6);
    } else if (isDuration(f) && auto.duration !== undefined) {
      const want = Number(auto.duration);
      if (f.type === 'enum') out[f.key] = nearest((f.options || []).filter(o => Number(o) > 0), o => Math.abs(Number(o) - want));
      else out[f.key] = Math.min(Math.max(want, f.min ?? want), f.max ?? want);
    } else if (isAudio(f) && auto.audio !== undefined) {
      out[f.key] = Boolean(auto.audio);
    } else if (f.type === 'boolean' && /safety_checker|safe_mode|content_filter/i.test(f.key)) {
      out[f.key] = false; // uncensored whenever the provider lets us choose
    }
  }
  return out;
}

/** References for a concrete model from the Auto model's inputs; null when the model can't take them. */
export function translateRefs(model: ModelInfo, slots: Record<string, string[]>): Record<string, string[]> | null {
  const roles = refRoles(model);
  const out: Record<string, string[]> = {};
  for (const [role, ids] of Object.entries(slots)) {
    if (!ids?.length) continue;
    const field = roles[role as keyof typeof roles];
    if (!field || ids.length > field.max) return null;
    out[field.key] = [...(out[field.key] || []), ...ids];
  }
  // Everything the model requires must be filled (e.g. an "Edit" variant needs references).
  if (model.refFields.some(f => f.required && !(out[f.key] || []).length)) return null;
  return out;
}

// ---------------------------------------------------------------- pricing and choosing

export interface RouterSettings {
  models: string[];
  creditValues: Record<string, number>;
  /** The user's own uncensored marks per model id (for providers that don't say). */
  marks: Record<string, boolean>;
}

/** Used for providers whose credit value depends on the user's plan until the user sets it. */
const FALLBACK_CREDIT_VALUE = 0.05;

export async function getRouterSettings(userId: string): Promise<RouterSettings> {
  const row = await one<{ router: any }>('select router from user_settings where user_id = $1', [userId]);
  const r = row?.router || {};
  return {
    models: Array.isArray(r.models) ? r.models.map(String) : [],
    creditValues: { ...(r.creditValues || {}) },
    marks: { ...(r.marks || {}) },
  };
}

export async function updateRouterSettings(userId: string, patch: Partial<Omit<RouterSettings, 'marks'>> & { marks?: Record<string, boolean | null> }) {
  const current = await getRouterSettings(userId);
  const next = {
    models: patch.models ? [...new Set(patch.models.map(String))].slice(0, 50) : current.models,
    creditValues: { ...current.creditValues },
    marks: { ...current.marks },
  };
  // A mark of null removes it (back to what the provider reports).
  for (const [id, value] of Object.entries(patch.marks || {})) {
    if (!/^[\w.-]+:[\w./-]+$/.test(id)) continue;
    if (typeof value === 'boolean') next.marks[id] = value; else delete next.marks[id];
  }
  for (const [id, value] of Object.entries(patch.creditValues || {})) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0 && n < 100) next.creditValues[id] = n;
  }
  await q(
    `insert into user_settings (user_id, router) values ($1, $2)
     on conflict (user_id) do update set router = excluded.router, updated_at = now()`, [userId, JSON.stringify(next)]);
  return getRouterSettings(userId);
}

/** A provider's cost in dollars: USD as is; credits at the user's value, else the provider's own, else a fallback. */
export const usd = (cost: Cost, provider: Pick<Provider, 'id' | 'unitValueUsd'>, values: Record<string, number>) =>
  cost.unit === 'USD' ? cost.amount : cost.amount * (values[provider.id] ?? provider.unitValueUsd ?? FALLBACK_CREDIT_VALUE);

// Balances are fetched at most once a minute per provider.
const balances = new Map<string, { at: number; amount: number | null }>();
async function balanceOf(userId: string, provider: Provider): Promise<number | null> {
  if (!provider.balance) return null;
  const key = `${userId}:${provider.id}`;
  const cached = balances.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.amount;
  const amount = await provider.balance().then(b => (typeof b.amount === 'number' ? b.amount : null)).catch(() => null);
  balances.set(key, { at: Date.now(), amount });
  return amount;
}

/** Uncensored versions first; then the known cheapest; unpriced ones last. Exported for tests. */
export function rankOptions<T extends { uncensored: boolean; usd: number | null }>(options: T[]): T[] {
  return [...options].sort((a, b) =>
    Number(b.uncensored) - Number(a.uncensored) || Number(a.usd === null) - Number(b.usd === null) || (a.usd ?? 0) - (b.usd ?? 0));
}

export interface RouteOption { provider: Provider; model: ModelInfo; settings: Record<string, unknown>; refSlots: Record<string, string[]>; cost: Cost | null; usd: number | null; balance: number | null; uncensored: boolean }

/**
 * Price every provider's version of an Auto model for this create box and pick the cheapest one whose
 * balance covers it (unknown prices or balances count as fine, but a known price wins).
 * `price` returns the cost of the concrete request (whole batch).
 */
export async function route(
  userId: string, autoModelId: string, settings: Record<string, unknown>, refSlots: Record<string, string[]>,
  price: (modelId: string, settings: Record<string, unknown>, refSlots: Record<string, string[]>) => Promise<Cost | null>,
): Promise<{ chosen: RouteOption; options: RouteOption[] }> {
  const key = autoModelId.slice(AUTO.length + 1);
  const family = (await families(userId)).get(key);
  if (!family) throw new ProviderError('None of your connected providers offers this model right now.', 400);
  const { creditValues: values, marks } = await getRouterSettings(userId);
  const compatible = family.candidates
    .map(c => ({ ...c, refs: translateRefs(c.model, refSlots) }))
    .filter((c): c is Candidate & { refs: Record<string, string[]> } => c.refs !== null);
  if (!compatible.length) throw new ProviderError(`No provider's ${family.name} can take these inputs. Remove some references and try again.`, 400);
  const options: RouteOption[] = await Promise.all(compatible.map(async c => {
    const s = translateSettings(c.model, settings);
    const [cost, balance] = await Promise.all([
      price(c.model.id, s, c.refs).catch(() => null),
      balanceOf(userId, c.provider),
    ]);
    return { provider: c.provider, model: c.model, settings: s, refSlots: c.refs, cost, usd: cost ? usd(cost, c.provider, values) : null, balance, uncensored: isUncensored(c.model, marks) };
  }));
  const affordable = options.filter(o => !o.cost || o.balance === null || o.balance >= o.cost.amount);
  if (!affordable.length) {
    const lines = options.map(o => `${o.provider.name}: needs ${o.cost!.amount} ${o.cost!.unit}, has ${o.balance}`).join('; ');
    throw new ProviderError(`Not enough balance for ${family.name} on any provider (${lines}).`, 400);
  }
  return { chosen: rankOptions(affordable)[0], options };
}
