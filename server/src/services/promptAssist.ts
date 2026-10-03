import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { q } from '../db.js';
import { ProviderError, type ModelInfo } from '../providers/types.js';
import { ownWorkspace } from './access.js';
import { primaryRefField } from './generations.js';
import { absPath } from './media.js';
import { getProviderRow, saveCredentials, saveState } from './providerSettings.js';
import {
  checkTokens, cleanAnswer, DEFAULT_ASSIST_MODEL, describeTarget, SYSTEM_PROMPT, tokens, userMessage, type ElementInfo, type RefInfo,
} from './promptRewrite.js';

/**
 * Prompt assistant: rewrites a short prompt into a detailed one with an LLM through OpenRouter (Grok by
 * default). The key and preferences live in provider_settings under "openrouter" (key encrypted).
 */
const ID = 'openrouter';
// OPENROUTER_BASE is for tests against a fake server.
const BASE = (process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const MAX_IMAGES = 12;

export interface AssistSettings { model: string; houseRules: string; showRefs: boolean }

export async function assistSettings(userId: string) {
  const row = await getProviderRow(userId, ID);
  const key: string = row.credentials.apiKey || '';
  return {
    configured: Boolean(key), keyHint: key ? `Key …${key.slice(-4)}` : null,
    model: String(row.state.model || DEFAULT_ASSIST_MODEL),
    houseRules: String(row.state.houseRules || ''),
    showRefs: row.state.showRefs === true,
  };
}

export async function updateAssistSettings(userId: string, patch: Partial<AssistSettings>) {
  const clean: Partial<AssistSettings> = {};
  if (typeof patch.model === 'string' && /^[\w.:/~-]{3,120}$/.test(patch.model)) clean.model = patch.model;
  if (typeof patch.houseRules === 'string') clean.houseRules = patch.houseRules.slice(0, 4000);
  if (typeof patch.showRefs === 'boolean') clean.showRefs = patch.showRefs;
  await saveState(userId, ID, clean);
  return assistSettings(userId);
}

async function call(path: string, key: string, init: RequestInit = {}, timeoutMs = 30_000) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/alexamiryan/spicy-studio', 'X-Title': 'Spicy Studio', ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(error => { throw new ProviderError(`Could not reach OpenRouter: ${error.message}`, 502); });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) {
    const status = response.ok ? Number(body.error?.code) || 502 : response.status;
    const message = body?.error?.message || `OpenRouter answered ${response.status}.`;
    if (status === 401) throw new ProviderError('OpenRouter didn\'t accept the key. Check it in Settings → Prompt assistant.', 401);
    if (status === 402) throw new ProviderError('Your OpenRouter balance is too low. Add credits at openrouter.ai/credits.', 402);
    if (status === 429) throw new ProviderError('OpenRouter is rate limiting. Try again in a moment.', 429);
    throw new ProviderError(`OpenRouter: ${message}`, status >= 400 && status < 600 ? status : 502);
  }
  return body;
}

/** Check a key with OpenRouter before keeping it. */
export async function saveAssistKey(userId: string, apiKey: string) {
  const key = String(apiKey || '').trim();
  if (!/^sk-or-[\w-]{10,}$/.test(key)) throw new ProviderError('That doesn\'t look like an OpenRouter key (it starts with sk-or-).', 400);
  await call('/key', key);
  await saveCredentials(userId, ID, { apiKey: key }, true);
  return assistSettings(userId);
}

export async function deleteAssistKey(userId: string) {
  await saveCredentials(userId, ID, {}, true);
}

let modelCache: { at: number; list: unknown[] } | null = null;

/** OpenRouter's models that answer in text (public list, cached for an hour). */
export async function assistModels() {
  if (modelCache && Date.now() - modelCache.at < 3600_000) return modelCache.list;
  const response = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(20_000) })
    .catch(error => { throw new ProviderError(`Could not reach OpenRouter: ${error.message}`, 502); });
  const body: any = await response.json().catch(() => ({}));
  const list = (body.data || [])
    .filter((m: any) => (m.architecture?.output_modalities || ['text']).includes('text'))
    .map((m: any) => ({
      id: m.id, name: m.name,
      vision: (m.architecture?.input_modalities || []).includes('image'),
      // Dollars per million tokens.
      input: Math.round(Number(m.pricing?.prompt || 0) * 1e6 * 100) / 100,
      output: Math.round(Number(m.pricing?.completion || 0) * 1e6 * 100) / 100,
    }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  modelCache = { at: Date.now(), list };
  return list;
}

/** A reference or element photo as a small JPEG data URL (videos use their thumbnail). */
async function dataUrl(file: string) {
  const jpeg = await sharp(await readFile(absPath(file))).rotate().resize(768, 768, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

export interface EnhanceInput {
  workspaceId: string; prompt: string; settings?: Record<string, unknown>;
  refSlots?: Record<string, string[]>; showRefs?: boolean;
}

/**
 * Rewrite a prompt for a model. Every @ token must survive (checked; one retry with the problem pointed out),
 * otherwise the rewrite comes back with warnings instead of silently breaking references.
 */
export async function enhancePrompt(userId: string, model: ModelInfo, input: EnhanceInput) {
  const workspace = await ownWorkspace(userId, input.workspaceId);
  const prompt = String(input.prompt || '').slice(0, 20000);
  if (!prompt.trim()) throw new ProviderError('Write what you want first; the assistant rewrites it.', 400);
  const settings = await assistSettings(userId);
  const key: string = (await getProviderRow(userId, ID)).credentials.apiKey || '';
  if (!key) throw new ProviderError('Add an OpenRouter key in Settings → Prompt assistant first.', 400);

  // References in the order the model gets them; only the primary input is addressable as @imageN
  // (the same input generation resolves @imageN against).
  const primaryKey = primaryRefField(model)?.key;
  const refs: (RefInfo & { file: string; thumb: string | null })[] = [];
  for (const field of model.refFields) {
    const ids = (input.refSlots?.[field.key] || []).map(String);
    if (!ids.length) continue;
    const rows = await q('select id, name, kind, file, thumb from refs where workspace_id = $1 and id = any($2::uuid[])', [input.workspaceId, ids]);
    ids.forEach((id, i) => {
      const r = rows.find(x => x.id === id);
      if (r) refs.push({ field: field.key, label: field.label, kind: r.kind === 'image' ? 'photo' : r.kind, name: r.name, primary: field.key === primaryKey, position: i + 1, file: r.file, thumb: r.thumb });
    });
  }
  const imageCount = refs.filter(r => r.primary).length;

  // Elements the prompt mentions (by name, any case).
  const mentioned = new Set(tokens(prompt));
  const elementRows = mentioned.size ? await q(
    `select e.name, e.description, coalesce(array_agg(r.file order by er.position) filter (where r.kind = 'image'), '{}') as files
       from elements e left join element_refs er on er.element_id = e.id left join refs r on r.id = er.ref_id
      where e.workspace_id = $1 and lower(e.name) = any($2::text[]) group by e.id`, [input.workspaceId, [...mentioned]]) : [];
  const elements: (ElementInfo & { files: string[] })[] = elementRows.map(e => ({ name: e.name, description: e.description || '', photos: e.files.length, files: e.files }));

  const withImages = input.showRefs ?? settings.showRefs;
  const text = userMessage({
    target: describeTarget(model, input.settings || {}), refs, elements, prompt, withImages,
    houseRules: settings.houseRules, workspaceRules: String(workspace.prefs?.assistRules || ''), workspaceName: workspace.name,
  });
  const content: any[] = [{ type: 'text', text }];
  if (withImages) {
    const shown: { label: string; file: string }[] = [
      ...refs.map(r => ({ label: r.primary ? `@image${r.position}` : `"${r.label}"`, file: r.kind === 'photo' ? r.file : r.thumb || '' })),
      ...elements.flatMap(e => e.files.slice(0, 3).map((file, i) => ({ label: `@${e.name} (photo ${i + 1})`, file }))),
    ].filter(x => x.file).slice(0, MAX_IMAGES);
    for (const s of shown) {
      try { content.push({ type: 'text', text: `Image ${s.label}:` }, { type: 'image_url', image_url: { url: await dataUrl(s.file) } }); }
      catch { /* an unreadable file just isn't shown */ }
    }
  }

  const messages: any[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }];
  let cost = 0;
  let rewritten = '';
  let check = { missing: [] as string[], invented: [] as string[], ok: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = await call('/chat/completions', key, {
      method: 'POST',
      body: JSON.stringify({ model: settings.model, messages, temperature: 0.7, max_tokens: 3000, usage: { include: true } }),
    }, 120_000);
    cost += Number(body.usage?.cost || 0);
    rewritten = cleanAnswer(body.choices?.[0]?.message?.content || '');
    if (!rewritten) throw new ProviderError('The assistant answered with nothing. Try again, or pick another model in Settings.', 502);
    check = checkTokens(prompt, rewritten, imageCount);
    if (check.ok) break;
    // One retry, pointing at exactly what went wrong.
    messages.push({ role: 'assistant', content: rewritten }, {
      role: 'user',
      content: `Fix the rewrite: ${[
        check.missing.length ? `these tokens are missing and must appear exactly as written: ${check.missing.map(t => `@${t}`).join(', ')}` : '',
        check.invented.length ? `these tokens don't exist and must be removed: ${check.invented.map(t => `@${t}`).join(', ')}` : '',
      ].filter(Boolean).join('; ')}. Answer with the full corrected prompt only.`,
    });
  }
  const warnings = [
    ...check.missing.map(t => `@${t} was dropped by the rewrite.`),
    ...check.invented.map(t => `@${t} was added but doesn't exist.`),
  ];
  return { prompt: rewritten, warnings, model: settings.model, cost: cost || null, sawImages: withImages };
}
