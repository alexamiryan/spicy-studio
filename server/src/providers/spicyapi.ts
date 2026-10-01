import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { fitImageUnder } from '../services/media.js';
import { getProviderRow } from '../services/providerSettings.js';
import {
  HIDDEN_SETTINGS, humanize, ProviderError,
  type Balance, type Cost, type CreateRequest, type MediaKind, type Modality, type ModelField,
  type ModelInfo, type NativeElements, type Provider, type RefField, type TaskResult, type TaskState,
} from './types.js';

const PROMPT_KEYS = ['prompt', 'text', 'caption'];
const IMAGE_LIMIT = 10 * 1024 * 1024;

function unwrap(prop: any): any {
  // `anyOf: [{type: X}, {type: 'null'}]` → X
  const variants = prop?.anyOf || prop?.oneOf;
  if (Array.isArray(variants)) {
    const real = variants.filter((v: any) => v?.type !== 'null');
    if (real.length === 1) return { ...prop, ...real[0], anyOf: undefined, oneOf: undefined };
  }
  if (Array.isArray(prop?.type)) {
    const types = prop.type.filter((t: string) => t !== 'null');
    if (types.length === 1) return { ...prop, type: types[0] };
  }
  return prop;
}

function mediaKind(key: string, prop: any): MediaKind {
  const hint = [prop['x-ui']?.accept, prop.contentMediaType, prop.items?.contentMediaType, prop['x-ui']?.mediaType, key]
    .flat().filter(Boolean).join(' ').toLowerCase();
  if (hint.includes('video')) return 'video';
  if (hint.includes('audio')) return 'audio';
  return 'image';
}

function isRefProp(key: string, prop: any) {
  const widget = prop['x-ui']?.widget;
  if (widget === 'upload' || widget === 'multi-upload') return true;
  if (widget) return false; // e.g. a "text" widget taking a web address
  const fmt = prop.format || prop.items?.format;
  return fmt === 'uri' && /(image|video|audio|frame|ref)/i.test(key);
}

// Friendly names for SpicyAPI's reference inputs (raw keys read like "Last image url").
const REF_LABELS: Record<string, string> = {
  image_url: 'Start frame', last_image_url: 'End frame', image_urls: 'References', video_url: 'Source video',
  reference_image_url: 'Face reference', reference_image_urls: 'Reference images', reference_video_urls: 'Reference videos',
  reference_audio_urls: 'Reference audio', audio_url: 'Audio track', mask_url: 'Mask',
};
// Show frames in the order they play (the schema's own order puts the end frame first).
const REF_ORDER = ['image_url', 'last_image_url', 'video_url', 'reference_image_url', 'image_urls', 'reference_image_urls',
  'reference_video_urls', 'reference_audio_urls', 'audio_url', 'mask_url'];

/** Reference inputs for documents (PDF, DOCX…) — this app only stores images, videos and audio. */
function isDocumentRef(key: string, prop: any) {
  const types = [prop.contentMediaType, prop.items?.contentMediaType].flat().filter(Boolean).join(' ').toLowerCase();
  if (types) return !/(image|video|audio)\//.test(types);
  return /file|document|doc_/i.test(key) && !/(image|video|audio|frame)/i.test(key);
}

function refLabel(key: string, prop: any, modality?: Modality) {
  if (key === 'image_url' && modality !== 'video') return 'Image';
  return REF_LABELS[key] || prop.title || prop['x-ui']?.label || humanize(key.replace(/_urls?$/, ''));
}

/** Convert a SpicyAPI JSON Schema into normalized fields. Exported for tests. */
/** Kling O3-style `elements`: named subjects, each a few images, mentioned in the prompt as @name. */
function nativeElementsOf(schema: any): NativeElements | undefined {
  const prop = unwrap(schema?.properties?.elements || {});
  const item = unwrap(prop.items || {});
  const images = unwrap(item.properties?.image_urls || {});
  if (prop.type !== 'array' || images.type !== 'array') return undefined;
  // "… 4K only." in the description: elements are rejected at other resolutions.
  const resolution = unwrap(schema?.properties?.resolution || {});
  const fourK = /\b4k only\b/i.test(prop.description || '') ? (resolution.enum || []).find((o: unknown) => /^4k$/i.test(String(o))) : undefined;
  return {
    max: prop.maxItems ?? 7, minImages: images.minItems ?? 1, maxImages: images.maxItems ?? 4, note: prop.description,
    ...(fourK !== undefined ? { requiresSetting: { key: 'resolution', value: fourK } } : {}),
  };
}

export function normalizeSchema(schema: any, modality?: Modality): { fields: ModelField[]; refFields: RefField[]; promptField?: string; nativeElements?: NativeElements } {
  const properties: Record<string, any> = schema?.properties || {};
  const required = new Set<string>(schema?.required || []);
  const entries = Object.entries(properties)
    .map(([key, raw], index) => ({ key, prop: unwrap(raw), index }))
    .sort((a, b) => (a.prop['x-ui']?.order ?? 1000 + a.index) - (b.prop['x-ui']?.order ?? 1000 + b.index));
  const fields: ModelField[] = [];
  const refFields: RefField[] = [];
  let promptField: string | undefined;
  for (const { key, prop } of entries) {
    if (prop['x-ui']?.hidden || HIDDEN_SETTINGS.test(key)) continue;
    const label = prop.title || prop['x-ui']?.label || humanize(prop.format === 'uri' ? key.replace(/_urls?$/, '') : key);
    if (isRefProp(key, prop)) {
      if (isDocumentRef(key, prop)) continue;
      const multi = prop.type === 'array' || prop['x-ui']?.widget === 'multi-upload';
      refFields.push({
        key, label: refLabel(key, prop, modality), kind: mediaKind(key, prop), required: required.has(key),
        max: multi ? (prop.maxItems ?? 16) : 1, description: prop.description, primary: prop['x-ui']?.primary === true,
        ...(prop.type === 'array' ? { array: true } : {}),
      });
      continue;
    }
    if (!promptField && PROMPT_KEYS.includes(key) && prop.type === 'string') { promptField = key; continue; }
    const ui = prop['x-ui'] || {};
    const base = {
      key, label, default: prop.default, required: required.has(key), description: prop.description,
      optionLabels: ui.enum_labels, unit: ui.unit, advanced: ui.advanced === true, placeholder: ui.placeholder,
    };
    if (Array.isArray(prop.enum)) {
      fields.push({ ...base, type: 'enum', options: prop.enum.filter((v: unknown) => v !== null) });
    } else if (prop.type === 'boolean') {
      fields.push({ ...base, type: 'boolean' });
    } else if (prop.type === 'integer' || prop.type === 'number') {
      fields.push({
        ...base, type: prop.type, min: prop.minimum ?? prop.exclusiveMinimum, max: prop.maximum ?? prop.exclusiveMaximum,
        step: prop.multipleOf ?? (prop.type === 'integer' ? 1 : undefined),
      });
    } else if (prop.type === 'string') {
      const long = prop['x-ui']?.widget === 'textarea' || (prop.maxLength ?? 0) > 300 || /negative/i.test(key);
      fields.push({ ...base, type: long ? 'text' : 'string' });
    }
    // Objects and other complex types are not exposed in the form.
  }
  const rank = (key: string) => (REF_ORDER.includes(key) ? REF_ORDER.indexOf(key) : REF_ORDER.length);
  refFields.sort((a, b) => rank(a.key) - rank(b.key));
  return { fields, refFields, promptField, nativeElements: nativeElementsOf(schema) };
}

/**
 * SpicyAPI rejects settings a model temporarily can't serve with e.g. "(enable_thinking=true: this model
 * does not accept this value right now; …)". Turn that into something actionable. Exported for tests.
 */
export function friendlyError(message: string): string {
  const blocked = [...message.matchAll(/(\w+)=([^:;()]+): this model does not accept this value right now/g)];
  if (!blocked.length) return message;
  const names = blocked.map(([, key, value]) => `${humanize(key)}${value === 'true' ? '' : ` = ${value}`}`);
  return `This model can't use ${names.join(', ')} right now. Turn ${blocked.length > 1 ? 'them' : 'it'} off in the settings and try again.`;
}

function formatPrice(pricing: any): string | undefined {
  if (!pricing) return undefined;
  const start = pricing.startingPrice ?? pricing.price;
  if (typeof start === 'number') return `from $${start}`;
  if (typeof start === 'string') return start.startsWith('$') || /[a-z]/i.test(start) ? start : `from $${start}`;
  if (start && typeof start === 'object') {
    const amount = start.amount ?? start.price ?? start.value;
    const unit = start.unit ?? start.per ?? pricing.unit;
    if (amount !== undefined) return `from $${amount}${unit ? `/${String(unit).replace(/^per[_ ]/, '')}` : ''}`;
  }
  return undefined;
}

function toModel(raw: any, fallbackModality?: Modality): ModelInfo {
  const modality: Modality = raw.modality === 'video' || raw.outputModality === 'video' ? 'video'
    : raw.modality === 'image' ? 'image' : (fallbackModality || 'image');
  const normalized = normalizeSchema(raw.inputSchema, modality);
  return {
    id: `spicyapi:${raw.model}`,
    providerId: 'spicyapi',
    model: raw.model,
    name: raw.displayName || raw.name || raw.model,
    vendor: raw.vendor || raw.family || raw.provider,
    modality,
    description: raw.description,
    ...normalized,
    price: formatPrice(raw.pricing),
    available: raw.enabled !== false && raw.available !== false,
  };
}

function mapState(state: string): TaskState {
  if (state === 'succeeded' || state === 'success' || state === 'completed') return 'succeeded';
  if (state === 'failed' || state === 'expired' || state === 'canceled' || state === 'cancelled') return 'failed';
  if (state === 'running' || state === 'processing') return 'running';
  return 'queued';
}

function firstNumber(obj: any, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v);
    if (v && typeof v === 'object' && typeof v.amount === 'number') return v.amount;
  }
  return undefined;
}

export class SpicyProvider implements Provider {
  id = 'spicyapi';
  name = 'SpicyAPI';
  authType = 'apiKey' as const;
  unit = 'USD';
  private cache = new Map<string, { at: number; value: any }>();

  constructor(private userId: string, private fetchFn: typeof fetch = fetch) {}

  private async apiKey(): Promise<string> {
    return (await getProviderRow(this.userId, this.id)).credentials.apiKey || '';
  }

  async configured() { return Boolean(await this.apiKey()); }

  async request(path: string, init: RequestInit & { timeout?: number } = {}): Promise<any> {
    const key = await this.apiKey();
    if (!key) throw new ProviderError('Add your SpicyAPI key in Settings.', 503);
    let response: Response;
    try {
      response = await this.fetchFn(`${config.spicyApiBase}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers as Record<string, string>),
        },
        signal: AbortSignal.timeout(init.timeout ?? 30000),
      });
    } catch (error: any) {
      throw new ProviderError(`SpicyAPI is unreachable: ${error.message}`);
    }
    let body: any;
    try { body = await response.json(); }
    catch { throw new ProviderError(`SpicyAPI returned HTTP ${response.status}.`); }
    if (body?.code !== 200) {
      const status = body?.code === 401 || response.status === 401 ? 401 : response.status >= 400 && response.status < 500 ? 400 : 502;
      throw new ProviderError(friendlyError(body?.msg || `SpicyAPI error ${body?.code ?? response.status}`), status);
    }
    return body.data;
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async listModels(modality: Modality) {
    return this.cached(`list:${modality}`, async () => {
      const data = await this.request(`/models?modality=${modality}&includeSchema=1`);
      const items: any[] = Array.isArray(data) ? data : data?.items || data?.models || data?.data || [];
      return items.filter(m => m?.model).map(m => toModel(m, modality)).filter(m => m.modality === modality);
    });
  }

  async getModel(model: string) {
    return this.cached(`model:${model}`, async () => {
      const data = await this.request(`/models/${model.split('/').map(encodeURIComponent).join('/')}`);
      return toModel(data);
    });
  }

  buildInput(req: CreateRequest) {
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req.settings)) {
      if (value !== '' && value !== null && value !== undefined) input[key] = value;
    }
    if (req.promptField && req.prompt) input[req.promptField] = req.prompt;
    return input;
  }

  private async inputWithRefs(req: CreateRequest) {
    const model = await this.getModel(req.model);
    const input = this.buildInput(req);
    for (const field of model.refFields) {
      const uris = req.refs[field.key] || [];
      if (!uris.length) continue;
      input[field.key] = field.array || field.max > 1 ? uris : uris[0];
    }
    if (req.elements?.length) {
      input.elements = req.elements.map(e => ({
        name: e.name, description: e.description || e.name, image_urls: e.images.map(i => i.uri),
      }));
    }
    return input;
  }

  async quote(req: CreateRequest): Promise<Cost | null> {
    const input = await this.inputWithRefs(req);
    const data = await this.request('/jobs/quote', { method: 'POST', body: JSON.stringify({ model: req.model, input }) });
    const amount = firstNumber(data, ['estimatedCost', 'cost', 'total', 'amount', 'price']);
    return amount === undefined ? null : { amount, unit: this.unit };
  }

  async upload(filePath: string, originalMime: string) {
    // SpicyAPI rejects reference images over 10 MiB: shrink them instead of failing.
    const { bytes, mime } = await fitImageUnder(await readFile(filePath), originalMime, IMAGE_LIMIT);
    const ticket = await this.request('/common/upload-url', {
      method: 'POST', body: JSON.stringify({ contentType: mime, bytes: bytes.length }),
    });
    if (ticket.maxBytes && bytes.length > ticket.maxBytes) {
      throw new ProviderError(`Reference is larger than SpicyAPI allows (${Math.round(ticket.maxBytes / 1048576)} MB).`, 400);
    }
    let put: Response;
    try {
      put = await this.fetchFn(ticket.uploadUrl, {
        method: ticket.method || 'PUT', headers: ticket.headers, body: new Uint8Array(bytes), signal: AbortSignal.timeout(180_000),
      });
    } catch (error: any) { throw new ProviderError(`Reference upload failed: ${error.message}`); }
    if (!put.ok) throw new ProviderError(`Reference upload failed (HTTP ${put.status}).`);
    const committed = await this.request(`/files/${encodeURIComponent(ticket.fileId)}/commit`, { method: 'POST' });
    return { uri: committed.uri, expiresAt: committed.expiresAt ? new Date(committed.expiresAt) : undefined };
  }

  async create(req: CreateRequest) {
    const input = await this.inputWithRefs(req);
    const data = await this.request('/jobs/createTask', {
      method: 'POST', headers: { 'Idempotency-Key': req.idempotencyKey },
      body: JSON.stringify({ model: req.model, input }),
    });
    return { taskId: data.taskId, state: mapState(data.state), estimatedCost: firstNumber(data, ['estimatedCost']) };
  }

  async task(taskId: string): Promise<TaskResult> {
    const data = await this.request(`/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
    const state = mapState(data.state);
    const assets = (data.output?.assets || [])
      .filter((a: any) => a?.url)
      .map((a: any) => ({ url: a.url, mime: a.mime || a.contentType || a.mimeType }));
    return {
      state,
      error: data.errorMessage || data.error?.message || (typeof data.error === 'string' ? data.error : undefined),
      cost: firstNumber(data, ['cost', 'actualCost', 'chargedCost']),
      assets,
    };
  }

  async balance(): Promise<Balance> {
    const data = await this.request('/chat/credit');
    const amount = firstNumber(data, ['available', 'balance', 'total']) ?? 0;
    const held = firstNumber(data, ['held']);
    return { amount, unit: this.unit, detail: held ? `$${held.toFixed(2)} held by running jobs` : undefined };
  }
}
