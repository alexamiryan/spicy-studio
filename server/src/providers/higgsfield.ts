import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { MIME_EXT, fitImageUnder } from '../services/media.js';
import { getProviderRow, saveCredentials, saveState } from '../services/providerSettings.js';
import {
  HIDDEN_SETTINGS, humanize, ProviderError,
  type Balance, type Cost, type CreateRequest, type MediaKind, type Modality, type ModelField,
  type ElementInput, type ModelInfo, type NativeElements, type Provider, type RefField, type TaskResult, type TaskState,
} from './types.js';

const ID = 'higgsfield';

/**
 * Models that take Higgsfield Elements (reusable characters/props stored in the user's Higgsfield account),
 * per the MCP's show_reference_elements documentation. Kling 3.0 only uses them together with a start image.
 */
const ELEMENT_MODELS: Record<string, Partial<NativeElements>> = {
  nano_banana_pro: {}, nano_banana_2: {}, gpt_image_2: {}, seedream_v4_5: {}, seedream_v5_lite: {}, cinematic_studio_2_5: {},
  cinematic_studio_video_v2: {}, cinematic_studio_3_0: {}, seedance_2_0: {},
  kling3_0: { requiresRef: 'start_image', note: 'Elements are used together with a start frame.' },
};
const IMAGE_LIMIT = 10 * 1024 * 1024;

/** OAuth client state persisted in provider_settings so the login survives restarts. */
class DbOAuthProvider implements OAuthClientProvider {
  pendingAuthorizationUrl?: URL;
  constructor(private userId: string, private redirect?: string) {}

  get redirectUrl() { return this.redirect; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Spicy Studio',
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    } as OAuthClientMetadata;
  }

  async state() {
    const value = randomBytes(16).toString('hex');
    await saveState(this.userId, ID, { oauthState: value });
    return value;
  }

  async clientInformation() {
    const { state } = await getProviderRow(this.userId, ID);
    const client = state.client as (OAuthClientInformationMixed & { redirect_uris?: string[] }) | undefined;
    // Re-register when the app is reached through a different origin than the one registered.
    if (client && this.redirect && client.redirect_uris && !client.redirect_uris.includes(this.redirect)) return undefined;
    return client;
  }

  async saveClientInformation(info: OAuthClientInformationMixed) { await saveState(this.userId, ID, { client: info }); }

  async tokens() { return (await getProviderRow(this.userId, ID)).credentials.tokens as OAuthTokens | undefined; }

  async saveTokens(tokens: OAuthTokens) { await saveCredentials(this.userId, ID, { tokens, connectedAt: new Date().toISOString() }); }

  redirectToAuthorization(url: URL) { this.pendingAuthorizationUrl = url; }

  async saveCodeVerifier(verifier: string) { await saveState(this.userId, ID, { codeVerifier: verifier }); }

  async codeVerifier() {
    const verifier = (await getProviderRow(this.userId, ID)).state.codeVerifier;
    if (!verifier) throw new Error('No pending Higgsfield login. Start again from Settings.');
    return verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') await saveCredentials(this.userId, ID, {}, true);
    if (scope === 'all' || scope === 'client') await saveState(this.userId, ID, { client: undefined });
    if (scope === 'verifier') await saveState(this.userId, ID, { codeVerifier: undefined });
  }
}

/** Parse an MCP tool result: structured content, else JSON text, else raw text. */
/** Turn Higgsfield's raw error text into one readable sentence. Exported for tests. */
export function friendlyHiggsfieldError(text: string): string {
  const raw = text.replace(/\s*Request ID:.*$/s, '').trim();
  if (/\b(503|502|504)\b|Service Unavailable|Bad Gateway|Gateway Timeout/i.test(raw)) {
    return 'Higgsfield is temporarily unavailable. Nothing was charged; try again in a minute.';
  }
  // e.g. `params failed validation [{"msg":"Value error, start_image/end_image cannot be combined with reference media", …}]`
  const messages = [...raw.matchAll(/"msg"\s*:\s*"(?:Value error,\s*)?([^"]+)"/g)].map(m => m[1]);
  if (messages.length) {
    const combined = messages.join('; ');
    if (/start_image\/end_image cannot be combined with reference media/i.test(combined)) {
      return 'This model takes either a Start/End frame or References, not both. Remove one of them and try again.';
    }
    return `Higgsfield rejected the settings: ${combined}.`;
  }
  return raw || 'Higgsfield returned an error.';
}

export function parseToolResult(result: any): any {
  const text = (result?.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
  if (result?.isError) throw new ProviderError(friendlyHiggsfieldError(text), 400);
  if (result?.structuredContent) return result.structuredContent;
  try { return JSON.parse(text); } catch { return text; }
}

/** Depth-first search for the first value whose key matches. */
export function findKey(obj: any, keys: string[], depth = 0): any {
  if (!obj || typeof obj !== 'object' || depth > 8) return undefined;
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  for (const value of Object.values(obj)) {
    const found = findKey(value, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const MEDIA_URL = /^https:\/\/\S+$/i;

function collectUrls(obj: any, out: string[] = [], depth = 0, key = ''): string[] {
  if (depth > 8 || obj === null || obj === undefined) return out;
  if (typeof obj === 'string') {
    if (MEDIA_URL.test(obj) && /(url|result|output|media|video|image|raw|download|src)/i.test(key) && !/(thumb|preview|poster|avatar|status|cancel|share|page)/i.test(key)) out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) { obj.forEach(v => collectUrls(v, out, depth + 1, key)); return out; }
  if (typeof obj === 'object') for (const [k, v] of Object.entries(obj)) collectUrls(v, out, depth + 1, k);
  return out;
}

export function mapJobState(value: unknown): TaskState {
  const s = String(value || '').toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'done', 'finished'].includes(s)) return 'succeeded';
  if (['failed', 'error', 'nsfw', 'canceled', 'cancelled', 'rejected', 'expired', 'ip_detected', 'lookup_failed', 'not_found'].includes(s)) return 'failed';
  if (['in_progress', 'running', 'processing', 'generating'].includes(s)) return 'running';
  return 'queued';
}

// Inputs that take exactly one file even when the catalog gives no limit.
const SINGLE_FILE_ROLE = /^(start|end|first|last)_(image|frame)$|^(mask|video|audio|driving_video|source_video)$/;

/**
 * Pull the job id out of a generate_* reply. Only explicit job ids count: replies can also carry
 * other ids (presets, folders, media), and polling one of those would look "queued" forever.
 * Exported for tests.
 */
export function extractJobId(data: any): string | undefined {
  const direct = findKey(data, ['job_id', 'jobId']);
  if (typeof direct === 'string' && direct) return direct;
  const ids = findKey(data, ['job_ids', 'jobIds']);
  if (Array.isArray(ids) && typeof ids[0] === 'string') return ids[0];
  // generate_image / generate_video: { results: [{ id, status, model, … }] }
  for (const key of ['results', 'jobs']) {
    const list = data && typeof data === 'object' ? data[key] ?? findKey(data, [key]) : undefined;
    const first = Array.isArray(list) ? list[0] : undefined;
    const id = first?.job_id ?? first?.id;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

/**
 * Higgsfield sometimes answers a generate call with "this prompt looks like preset X, ask the user"
 * instead of generating. Returns that preset's id so the call can be repeated with it declined.
 * Exported for tests.
 */
export function presetRecommendation(data: any): string | undefined {
  const notice = data?.notice;
  if (!notice || !/preset/i.test(`${notice.type} ${notice.message}`)) return undefined;
  // Higgsfield spells out the literal-retry answer: data.retry_literal_with.declined_preset_id.
  const id = notice.data?.retry_literal_with?.declined_preset_id ?? findKey(notice.data, ['declined_preset_id', 'preset_id', 'presetId', 'id']);
  return typeof id === 'string' && id ? id : undefined;
}

/** Short human-readable summary of an unexpected reply, for the failed card. */
function describeReply(data: any): string {
  if (typeof data === 'string') return data.slice(0, 300);
  const message = findKey(data, ['message', 'error', 'detail', 'reason']);
  if (typeof message === 'string') return message.slice(0, 300);
  const hints = ['recovery_tool', 'preset_id', 'recommended_preset', 'adjustments'].filter(k => findKey(data, [k]) !== undefined);
  return `reply had ${hints.length ? hints.join(', ') : Object.keys(data || {}).join(', ') || 'no content'}`;
}

/**
 * Video duration: whole seconds, using the range stated in the description ("Duration in seconds (2-30),
 * or -1 to let the model choose") rather than the raw min, and exposing -1 as "Smart".
 */
function durationField(p: any): Pick<ModelField, 'type' | 'min' | 'max' | 'step' | 'unit' | 'optionLabels'> {
  const text = String(p.description || '');
  const range = /\((\d+)\s*[-–]\s*(\d+)\)/.exec(text);
  const smart = /(^|[^\d])-1\b/.test(text) || p.min === -1;
  let min = range ? Number(range[1]) : p.min;
  if (typeof min === 'number' && min < 1) min = 1;
  return {
    type: 'integer', step: 1, unit: 's', min, max: range ? Number(range[2]) : p.max,
    optionLabels: smart ? { '-1': 'Smart' } : undefined,
  };
}

/** Normalize a `models_explore` item. Exported for tests. */
export function normalizeHiggsfieldModel(item: any): ModelInfo {
  const modality: Modality = item.output_type === 'video' ? 'video' : 'image';
  const fields: ModelField[] = [];
  if (Array.isArray(item.aspect_ratios) && item.aspect_ratios.length) {
    fields.push({ key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', options: item.aspect_ratios, default: item.aspect_ratios.includes('9:16') ? '9:16' : item.aspect_ratios[0] });
  }
  const durations = item.durations || item.duration_options;
  if (Array.isArray(durations) && durations.length) {
    fields.push({ key: 'duration', label: 'Duration (s)', type: 'enum', options: durations.map(Number).filter(n => !Number.isNaN(n)), default: Number(durations[0]) });
  }
  for (const p of item.parameters || []) {
    if (!p?.name || p.name === 'folder_id' || HIDDEN_SETTINGS.test(p.name)) continue;
    const base = { key: p.name, label: humanize(p.name), default: p.default, required: p.required === 'required', description: p.description };
    if (Array.isArray(p.options) && p.options.length) fields.push({ ...base, type: 'enum', options: p.options });
    else if (p.type === 'bool' || p.type === 'boolean') fields.push({ ...base, type: 'boolean' });
    else if (/duration/i.test(p.name) && (p.type === 'number' || p.type === 'integer')) fields.push({ ...base, ...durationField(p) });
    else if (p.type === 'number' || p.type === 'integer') fields.push({ ...base, type: 'number', min: p.min, max: p.max });
    else if (p.type === 'string') fields.push({ ...base, type: 'string' });
  }
  const refFields: RefField[] = [];
  for (const m of item.medias || []) {
    for (const role of m.roles?.length ? m.roles : [m.name || 'image']) {
      refFields.push({
        key: role,
        label: role === 'image_references' ? 'References' : humanize(role),
        kind: (['image', 'video', 'audio'].includes(m.type) ? m.type : 'image') as MediaKind,
        max: SINGLE_FILE_ROLE.test(role) ? 1 : (m.max ?? 14),
        required: Boolean(m.required),
      });
    }
  }
  return {
    id: `${ID}:${item.id}`,
    providerId: ID,
    model: item.id,
    name: item.name || item.id,
    vendor: item.provider_name || undefined,
    modality,
    description: item.description || undefined,
    promptField: 'prompt',
    fields,
    refFields,
    nativeElements: ELEMENT_MODELS[item.id] ? { max: 7, minImages: 1, maxImages: 8, ...ELEMENT_MODELS[item.id] } : undefined,
    available: true,
  };
}

export class HiggsfieldProvider implements Provider {
  id = ID;
  name = 'Higgsfield';
  authType = 'oauth' as const;
  unit = 'credits';
  private client?: Client;
  private connecting?: Promise<Client>;
  private catalog?: { at: number; items: ModelInfo[] };

  constructor(private userId: string) {}

  async configured() { return Boolean((await getProviderRow(this.userId, ID)).credentials.tokens); }

  /** Begin OAuth. Returns the URL the browser should open. */
  async startLogin(redirectUrl: string): Promise<string | null> {
    await saveState(this.userId, ID, { redirectUrl });
    const provider = new DbOAuthProvider(this.userId, redirectUrl);
    const result = await auth(provider, { serverUrl: config.higgsfieldMcpUrl });
    if (result === 'AUTHORIZED') return null;
    if (!provider.pendingAuthorizationUrl) throw new ProviderError('Higgsfield did not return a login URL.');
    return provider.pendingAuthorizationUrl.toString();
  }

  async finishLogin(code: string, stateParam: string | undefined) {
    const row = await getProviderRow(this.userId, ID);
    if (!row.state.oauthState || row.state.oauthState !== stateParam) throw new ProviderError('Login expired or state mismatch. Try connecting again.', 400);
    const provider = new DbOAuthProvider(this.userId, row.state.redirectUrl);
    const result = await auth(provider, { serverUrl: config.higgsfieldMcpUrl, authorizationCode: code });
    await saveState(this.userId, ID, { oauthState: undefined, codeVerifier: undefined });
    this.reset();
    if (result !== 'AUTHORIZED') throw new ProviderError('Higgsfield login did not complete.');
  }

  async disconnect() {
    await saveCredentials(this.userId, ID, {}, true);
    this.reset();
  }

  private reset() {
    this.client?.close().catch(() => {});
    this.client = undefined;
    this.connecting = undefined;
    this.catalog = undefined;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!(await this.configured())) throw new ProviderError('Connect your Higgsfield account in Settings.', 503);
    this.connecting ||= (async () => {
      const row = await getProviderRow(this.userId, ID);
      const transport = new StreamableHTTPClientTransport(new URL(config.higgsfieldMcpUrl), {
        authProvider: new DbOAuthProvider(this.userId, row.state.redirectUrl),
      });
      const client = new Client({ name: 'spicy-studio', version: '1.0.0' });
      try {
        await client.connect(transport);
      } catch (error: any) {
        this.connecting = undefined;
        if (/unauthori[sz]ed|401/i.test(String(error?.message))) {
          throw new ProviderError('Higgsfield login expired. Reconnect in Settings.', 401);
        }
        throw new ProviderError(`Higgsfield is unreachable: ${error.message}`);
      }
      this.client = client;
      return client;
    })();
    return this.connecting;
  }

  async call(name: string, args: Record<string, unknown>, retry = true): Promise<any> {
    const client = await this.connect();
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
      return parseToolResult(result);
    } catch (error: any) {
      if (error instanceof ProviderError) throw error;
      // Session dropped (server restart, idle timeout): reconnect once.
      this.reset();
      if (retry) return this.call(name, args, false);
      throw new ProviderError(`Higgsfield ${name} failed: ${error.message}`);
    }
  }

  private loadingCatalog?: Promise<ModelInfo[]>;

  /**
   * The model catalog, cached for 10 minutes. A failed or empty answer never replaces a good catalog
   * (a hiccup on Higgsfield's side would otherwise make every model "not available" until the cache expires).
   */
  private async allModels(force = false): Promise<ModelInfo[]> {
    if (!force && this.catalog && Date.now() - this.catalog.at < 10 * 60_000) return this.catalog.items;
    this.loadingCatalog ||= this.fetchCatalog().finally(() => { this.loadingCatalog = undefined; });
    try {
      const items = await this.loadingCatalog;
      this.catalog = { at: Date.now(), items };
      return items;
    } catch (error) {
      if (this.catalog) {
        console.warn(`[higgsfield] model list refresh failed, keeping the previous one: ${(error as Error).message}`);
        return this.catalog.items;
      }
      throw error;
    }
  }

  private async fetchCatalog(): Promise<ModelInfo[]> {
    const items: ModelInfo[] = [];
    for (const type of ['image', 'video'] as const) {
      let after: string | undefined;
      let count = 0;
      for (let page = 0; page < 10; page++) {
        const data = await this.call('models_explore', { action: 'list', type, limit: 100, ...(after ? { after } : {}) });
        for (const item of data?.items || []) if (item?.id) { items.push(normalizeHiggsfieldModel(item)); count++; }
        after = data?.next_page_token;
        if (!data?.has_more || !after) break;
      }
      if (!count) throw new ProviderError(`Higgsfield returned no ${type} models. Try again in a moment.`);
    }
    return items;
  }

  async listModels(modality: Modality) { return (await this.allModels()).filter(m => m.modality === modality); }

  async getModel(model: string) {
    let found = (await this.allModels()).find(m => m.model === model);
    // Not in the cached list: fetch a fresh one before calling it unavailable.
    if (!found && (!this.catalog || Date.now() - this.catalog.at > 30_000)) found = (await this.allModels(true)).find(m => m.model === model);
    if (!found) throw new ProviderError(`Higgsfield model ${model} is not available right now.`, 404);
    return found;
  }

  private params(req: CreateRequest, extra: Record<string, unknown> = {}) {
    const params: Record<string, unknown> = { model: req.model, use_unlim: false, count: 1, ...extra };
    for (const [key, value] of Object.entries(req.settings)) {
      if (value !== '' && value !== null && value !== undefined) params[key] = value;
    }
    if (req.prompt) params.prompt = req.prompt;
    const medias = Object.entries(req.refs).flatMap(([role, values]) => values.map(value => ({ value, role })));
    if (medias.length) params.medias = medias;
    return params;
  }

  private tool(modality: Modality) { return modality === 'video' ? 'generate_video' : 'generate_image'; }

  /** Call generate_image/video; if Higgsfield suggests a preset instead, decline it once and repeat (literal prompt). */
  private async generateCall(req: CreateRequest, extra: Record<string, unknown> = {}) {
    const data = await this.call(this.tool(req.modality), { params: this.params(req, extra) });
    const preset = presetRecommendation(data);
    if (!preset || extractJobId(data)) return data;
    return this.call(this.tool(req.modality), { params: this.params(req, { ...extra, declined_preset_id: preset }) });
  }

  async quote(req: CreateRequest): Promise<Cost | null> {
    const data = await this.generateCall(req, { get_cost: true });
    const credits = findKey(data, ['credits_exact', 'credits']);
    return typeof credits === 'number' ? { amount: credits, unit: this.unit } : null;
  }

  async upload(filePath: string, originalMime: string, filename: string) {
    // Higgsfield's video models fail large inputs ("Input file is too large") without saying so over
    // the API, so big images (e.g. 4K PNGs) are re-encoded under the limit first.
    const { bytes, mime } = await fitImageUnder(await readFile(filePath), originalMime, IMAGE_LIMIT);
    const kind = mime.split('/')[0];
    const base = (filename || path.basename(filePath)).replace(/\.[^.]+$/, '');
    const name = `${base}${MIME_EXT[mime] || path.extname(filename || filePath)}`;
    const ticket = await this.call('media_upload', { filename: name, content_type: mime });
    const uploadUrl = findKey(ticket, ['upload_url', 'uploadUrl', 'url']);
    const mediaId = findKey(ticket, ['media_id', 'mediaId', 'id']);
    if (!uploadUrl || !mediaId) throw new ProviderError('Higgsfield did not return an upload URL.');
    const headers = findKey(ticket, ['headers']) || { 'Content-Type': mime };
    const put = await fetch(uploadUrl, { method: 'PUT', headers, body: new Uint8Array(bytes), signal: AbortSignal.timeout(180_000) });
    if (!put.ok) throw new ProviderError(`Higgsfield upload failed (HTTP ${put.status}).`);
    await this.call('media_confirm', { media_id: mediaId, type: ['image', 'video', 'audio'].includes(kind) ? kind : 'image' });
    const url = findKey(ticket, ['url']);
    return { uri: String(mediaId), url: typeof url === 'string' && /^https:/.test(url) ? url : undefined };
  }

  /**
   * The Higgsfield Element for one of our @elements: created in the user's Higgsfield account on first use
   * and reused until its photos, name or description change (Higgsfield's tools can't edit elements).
   */
  private async remoteElement(element: ElementInput): Promise<string> {
    const signature = createHash('sha256')
      .update(JSON.stringify([element.name, element.description, element.images.map(i => i.file)])).digest('hex');
    const cached = await one<{ signature: string; remote_id: string }>(
      'select signature, remote_id from provider_elements where user_id = $1 and provider_id = $2 and element_id = $3', [this.userId, ID, element.id]);
    if (cached?.signature === signature) return cached.remote_id;
    const medias = element.images.map(image => {
      if (!image.url) throw new ProviderError(`Could not prepare @${element.name} for Higgsfield (missing image URL).`);
      return { id: image.uri, url: image.url, type: 'media_input' };
    });
    const data = await this.call('show_reference_elements', {
      action: 'create', name: element.name.slice(0, 32), category: 'auto', medias,
      ...(element.description ? { description: element.description } : {}),
    });
    const remote = findKey(data, ['element_id']) ?? data?.element?.id ?? data?.id ?? findKey(data, ['element'])?.id;
    if (typeof remote !== 'string' || !remote) {
      console.warn('[higgsfield] element create reply without id:', JSON.stringify(data).slice(0, 2000));
      throw new ProviderError(`Higgsfield did not create the element @${element.name} (${describeReply(data)}).`);
    }
    await q(
      `insert into provider_elements (user_id, provider_id, element_id, signature, remote_id) values ($1,$2,$3,$4,$5)
       on conflict (user_id, provider_id, element_id) do update set signature = excluded.signature, remote_id = excluded.remote_id, created_at = now()`,
      [this.userId, ID, element.id, signature, remote]);
    return remote;
  }

  /** Swap `@name` mentions for Higgsfield's element placeholders (pricing keeps the names: nothing is created then). */
  private async withElements(req: CreateRequest): Promise<CreateRequest> {
    if (!req.elements?.length || req.quote || !req.prompt) return req;
    let prompt = req.prompt;
    for (const element of req.elements) {
      const remote = await this.remoteElement(element);
      const mention = new RegExp(`(^|[^\\w@])@${element.name.replace(/[-]/g, '\\-')}(?![\\w-])`, 'gi');
      prompt = prompt.replace(mention, (_m, lead: string) => `${lead}<<<${remote}>>>`);
    }
    return { ...req, prompt };
  }

  async create(input: CreateRequest) {
    const req = await this.withElements(input);
    // The app always generates the prompt as written (a suggested preset is declined automatically).
    const data = await this.generateCall(req);
    if (findKey(data, ['unlim_choice'])) throw new ProviderError('Higgsfield asked whether to use unlimited generations; this app always pays with credits.', 400);
    const jobId = extractJobId(data);
    if (!jobId) {
      console.warn('[higgsfield] generate reply without job id:', JSON.stringify(data).slice(0, 3000));
      throw new ProviderError(`Higgsfield did not start the generation (${describeReply(data)}). Nothing was charged.`);
    }
    const credits = findKey(data, ['credits_exact', 'credits']);
    return { taskId: String(jobId), state: 'queued' as TaskState, estimatedCost: typeof credits === 'number' ? credits : undefined };
  }

  async task(taskId: string): Promise<TaskResult> {
    const data = await this.call('jobs_wait', { jobs: [{ index: 0, job_id: taskId }], timeout_seconds: 0 });
    const job = (findKey(data, ['jobs', 'results', 'items']) || [])[0] || data;
    let state = mapJobState(findKey(job, ['status', 'state']));
    // A lookup error that Higgsfield says won't resolve by retrying is final.
    if (state !== 'succeeded' && job?.retryable === false && job?.error) state = 'failed';
    const reason = findKey(job, ['error', 'error_message', 'reason', 'message']);
    const status = String(findKey(job, ['status']) ?? '');
    const error = state !== 'failed' ? undefined
      : reason ? String(reason)
      : status === 'nsfw' ? "Higgsfield's content filter blocked this result. Failed jobs are refunded."
      : "Higgsfield stopped this job without giving a reason (its website may show one). Failed jobs are refunded.";
    const urls = state === 'succeeded' ? [...new Set(collectUrls(job))] : [];
    const credits = findKey(job, ['credits', 'cost']);
    return {
      state,
      error,
      cost: typeof credits === 'number' ? credits : undefined,
      assets: urls.map(url => ({ url, remoteRef: taskId })),
    };
  }

  async balance(): Promise<Balance> {
    const data = await this.call('balance', {});
    return { amount: Number(data?.credits ?? 0), unit: this.unit, detail: data?.subscription_plan_type ? `${data.subscription_plan_type} plan` : undefined };
  }
}
