import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fitImageUnder } from '../services/media.js';
import { getProviderRow } from '../services/providerSettings.js';
import catalogJson from './poyo-catalog.json' with { type: 'json' };
import { normalizeSchema } from './spicyapi.js';
import {
  ProviderError,
  type Balance, type Cost, type CreateRequest, type Modality, type ModelInfo, type Provider, type TaskResult, type TaskState,
} from './types.js';

const ID = 'poyo';
const BASE = process.env.POYO_API_BASE || 'https://api.poyo.ai/api';
const IMAGE_LIMIT = 10 * 1024 * 1024;

interface Tier { model?: string; credits: number; unit?: string; spec?: string; description?: string; [k: string]: unknown }
interface Product {
  id: string; name: string; vendor?: string; modality: Modality; tasks: string[]; doc?: string;
  models: string[]; input: any; pricing: Tier[];
}
const CATALOG = (catalogJson as unknown as { products: Product[] }).products;

// Inputs the app never shows: `n` (the app batches with separate jobs), web links and documents, webhooks.
const DROP = /^(n|callback_url|reference_link_urls?|reference_file_urls?)$/;
const humanize = (s: string) => s.replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, c => c.toUpperCase());

/**
 * PoYo documents options like `size` as "a preset, or WIDTHxHEIGHT, or {width, height}". The app offers
 * the preset list: take the enum branch of such unions. Unsupported inputs are removed.
 */
function simplify(input: any) {
  const properties: Record<string, any> = {};
  for (const [key, raw] of Object.entries<any>(input.properties || {})) {
    if (DROP.test(key)) continue;
    let prop = raw;
    const variants = prop.oneOf || prop.anyOf;
    if (Array.isArray(variants)) {
      const preset = variants.find((v: any) => Array.isArray(v.enum));
      if (preset) prop = { ...prop, ...preset, oneOf: undefined, anyOf: undefined };
    }
    properties[key] = prop;
  }
  return { ...input, properties, required: (input.required || []).filter((k: string) => properties[k]) };
}

// Products whose variants are different models rather than modes of one.
const NAMES: Record<string, string> = {
  'nano-banana-2': 'Nano Banana 2', 'nano-banana-2-edit': 'Nano Banana 2 · Edit',
  'nano-banana-pro': 'Nano Banana Pro', 'nano-banana-pro-edit': 'Nano Banana Pro · Edit',
  'nano-banana-2-new': 'Nano Banana 2 New', 'nano-banana-2-new-edit': 'Nano Banana 2 New · Edit',
  'nano-banana-2-official': 'Nano Banana 2 Official', 'nano-banana-2-official-edit': 'Nano Banana 2 Official · Edit',
};

/** Variant name shown after the product name: what differs from the product's other variants. */
function variantLabel(product: Product, model: string) {
  if (product.models.length < 2) return '';
  let prefix = product.models.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); });
  if (product.models.includes(prefix)) prefix = prefix.replace(/[-/._]*$/, '');
  // Words already in the product name ("Veo 3.1 Official · Fast official") are left out.
  const known = new Set(product.name.toLowerCase().split(/[\s.]+/).filter(w => w !== 'video' && w !== 'image'));
  const rest = humanize(model.slice(prefix.length).replace(/^[-/._]+/, '')).split(' ').filter(w => w && !known.has(w.toLowerCase())).join(' ');
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : 'Standard';
}

/** Shape a variant's inputs to what it does (the docs share one schema across a product's variants). */
function forVariant(product: Product, model: string, info: Pick<ModelInfo, 'refFields'>) {
  const editPair = product.models.includes(`${model}-edit`);
  let refFields = info.refFields;
  if (/text-to-video/.test(model) || (editPair && product.modality === 'image')) refFields = [];
  const needsImage = /-edit$|edit-|image-to-video|first-last-frame|keyframes|motion-control|animate|avatar/.test(model);
  const needsVideo = /extend-video|video-to-video|edit-video|motion-control|animate-(replace|move)/.test(model);
  // Image-to-video variants don't take a source video (the docs share inputs with video-edit variants).
  if (/image-to-video|first-last-frame|keyframes/.test(model) && !needsVideo) refFields = refFields.filter(f => f.kind !== 'video' || /reference/.test(f.key));
  // The input a variant can't do without: the start image, or the source video.
  const pick = (kind: 'image' | 'video') => refFields.find(f => f.kind === kind && /^(start_image_url|image_urls?|video_urls?)$/.test(f.key))
    || refFields.find(f => f.kind === kind);
  const mustImage = needsImage ? pick('image') : undefined;
  const mustVideo = needsVideo ? pick('video') : undefined;
  return refFields.map(f => (f === mustImage || f === mustVideo) && !f.required ? { ...f, required: true } : f);
}

function toModels(): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const product of CATALOG) {
    const schema = simplify(product.input);
    for (const model of product.models) {
      const normalized = normalizeSchema(schema, product.modality);
      const label = variantLabel(product, model);
      const tiers = product.pricing.filter(t => t.model === model);
      const cheapest = Math.min(...(tiers.length ? tiers : product.pricing).map(t => t.credits));
      out.push({
        id: `${ID}:${model}`, providerId: ID, model,
        name: NAMES[model] || (label ? `${product.name} · ${label}` : product.name),
        vendor: product.vendor, modality: product.modality,
        description: product.tasks.length ? product.tasks.join(' · ') : undefined,
        fields: normalized.fields, promptField: normalized.promptField ?? 'prompt',
        refFields: forVariant(product, model, normalized),
        price: Number.isFinite(cheapest) ? `from ${cheapest} cr` : undefined,
        available: true,
      });
    }
  }
  return out;
}

let models: ModelInfo[] | undefined;
const allModels = () => (models ||= toModels());

/**
 * Credits from PoYo's published price tiers: the tier for this model whose spec matches the chosen
 * settings best (e.g. "1080p"), times seconds for per-second pricing. PoYo has no quote endpoint.
 * Exported for tests.
 */
export function estimateCredits(model: string, settings: Record<string, unknown>, defaults: Record<string, unknown> = {}): number | null {
  const product = CATALOG.find(p => p.models.includes(model));
  if (!product) return null;
  // This variant's tiers; otherwise the product's (edit variants are often priced like their base model).
  const own = product.pricing.filter(t => t.model === model);
  const base = product.pricing.filter(t => t.model && model.startsWith(String(t.model)));
  const tiers = own.length ? own : base.length ? base : product.pricing;
  if (!tiers.length) return null;
  const values = Object.values({ ...defaults, ...settings }).filter(v => v !== undefined && v !== null && v !== '').map(v => String(v).toLowerCase());
  const score = (t: Tier) => Object.entries(t)
    .filter(([k, v]) => !['credits', 'unit', 'model', 'description'].includes(k) && (typeof v === 'string' || typeof v === 'number'))
    .reduce((n, [, v]) => n + (values.some(x => x === String(v).toLowerCase() || String(v).toLowerCase().split(/[\s,/]+/).includes(x)) ? 1 : 0), 0);
  const tier = tiers.reduce((best, t) => (score(t) > score(best) ? t : best), tiers[0]);
  const seconds = Number(settings.duration ?? defaults.duration);
  return /second/i.test(String(tier.unit || tier.description || '')) && seconds > 0 ? tier.credits * seconds : tier.credits;
}

function mapState(status: string): TaskState {
  if (status === 'finished') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  return 'queued';
}

export class PoyoProvider implements Provider {
  id = ID;
  name = 'PoYo';
  authType = 'apiKey' as const;
  unit = 'credits';
  /** PoYo's price tiers list 5 credits = $0.025. */
  unitValueUsd = 0.005;

  constructor(private userId: string, private fetchFn: typeof fetch = fetch) {}

  private async apiKey() { return (await getProviderRow(this.userId, ID)).credentials.apiKey || ''; }
  async configured() { return Boolean(await this.apiKey()); }

  async request(pathname: string, init: RequestInit & { timeout?: number } = {}): Promise<any> {
    const key = await this.apiKey();
    if (!key) throw new ProviderError('Add your PoYo API key in Settings.', 503);
    let response: Response;
    try {
      response = await this.fetchFn(`${BASE}${pathname}`, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(init.timeout ?? 30_000),
      });
    } catch (error: any) {
      throw new ProviderError(`PoYo is unreachable: ${error.message}`);
    }
    let body: any;
    try { body = await response.json(); }
    catch { throw new ProviderError(`PoYo returned HTTP ${response.status}.`); }
    if (!response.ok || (body?.code && body.code !== 200) || body?.error) {
      const status = response.status === 401 || body?.code === 401 ? 401 : response.status >= 400 && response.status < 500 ? 400 : 502;
      const message = body?.error?.message || body?.message || `PoYo error ${body?.code ?? response.status}`;
      throw new ProviderError(status === 401 ? 'PoYo rejected the API key. Check it in Settings → Providers.' : message, status);
    }
    return body.data;
  }

  async listModels(modality: Modality) { return allModels().filter(m => m.modality === modality); }

  async getModel(model: string) {
    const found = allModels().find(m => m.model === model);
    if (!found) throw new ProviderError(`PoYo model ${model} is not available.`, 404);
    return found;
  }

  async quote(req: CreateRequest): Promise<Cost | null> {
    const model = await this.getModel(req.model);
    const defaults = Object.fromEntries(model.fields.filter(f => f.default !== undefined).map(f => [f.key, f.default]));
    const credits = estimateCredits(req.model, req.settings, defaults);
    return credits === null ? null : { amount: credits, unit: this.unit };
  }

  async upload(filePath: string, originalMime: string, filename: string) {
    const { bytes, mime } = await fitImageUnder(await readFile(filePath), originalMime, IMAGE_LIMIT);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename || path.basename(filePath));
    const data = await this.request('/common/upload/stream', { method: 'POST', body: form, timeout: 180_000 });
    const url = data?.file_url || data?.download_url;
    if (!url) throw new ProviderError('PoYo did not return an uploaded file URL.');
    // Images are kept 72 hours and videos 24 hours; the app re-uploads after that.
    const expiresAt = data.expires_at ? new Date(data.expires_at) : new Date(Date.now() + (mime.startsWith('video/') ? 20 : 66) * 3600_000);
    return { uri: String(url), url: String(url), expiresAt };
  }

  private async input(req: CreateRequest) {
    const model = await this.getModel(req.model);
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req.settings)) {
      if (value !== '' && value !== null && value !== undefined) input[key] = value;
    }
    if (req.prompt) input[model.promptField || 'prompt'] = req.prompt;
    for (const field of model.refFields) {
      const uris = req.refs[field.key] || [];
      if (uris.length) input[field.key] = field.array || field.max > 1 ? uris : uris[0];
    }
    return input;
  }

  async create(req: CreateRequest) {
    const data = await this.request('/generate/submit', {
      method: 'POST', body: JSON.stringify({ model: req.model, input: await this.input(req) }),
    });
    if (!data?.task_id) throw new ProviderError('PoYo did not start the generation.');
    return { taskId: String(data.task_id), state: mapState(String(data.status || 'not_started')) };
  }

  async task(taskId: string): Promise<TaskResult> {
    const data = await this.request(`/generate/status/${encodeURIComponent(taskId)}`);
    const state = mapState(String(data?.status || ''));
    const assets = (data?.files || [])
      .filter((f: any) => f?.file_url && (f.file_type === 'image' || f.file_type === 'video'))
      .map((f: any) => ({ url: f.file_url, mime: f.content_type || (f.file_type === 'video' ? 'video/mp4' : undefined) }));
    return {
      state,
      error: state === 'failed' ? (data?.error_message || 'PoYo stopped this job without giving a reason. Failed jobs are not charged.') : undefined,
      cost: typeof data?.credits_amount === 'number' ? data.credits_amount : undefined,
      assets,
    };
  }

  async balance(): Promise<Balance> {
    const data = await this.request('/user/balance');
    return { amount: Number(data?.credits_amount ?? 0), unit: this.unit };
  }
}
