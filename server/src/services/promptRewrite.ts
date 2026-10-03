import type { ModelInfo } from '../providers/types.js';
import { MENTION } from './prompt.js';

// Pure parts of the prompt assistant (no database or network), so they can be unit tested.

export const DEFAULT_ASSIST_MODEL = 'x-ai/grok-4.7';

export const SYSTEM_PROMPT = `You rewrite prompts for AI image and video generation models. The user writes short, plain instructions; you turn them into one detailed, precise prompt that gets the best possible result from the target model.

Rules:
1. Tokens that start with @ (like @image1 or @Mia) link to reference photos and elements; the studio resolves them after you. Keep every token exactly as written, including the @, and keep the role the user gave it ("body reference", "starting frame", "outfit from", "same environment as"). Never add tokens that aren't listed below, never rename, merge or drop them, and don't replace them with descriptions.
2. Keep the user's intent, content and level of explicitness exactly. Don't censor, soften, moralize or add disclaimers, and don't add sexual content or nudity they didn't ask for. Everyone depicted is a fictional adult.
3. Identity, body, outfit and environment come from the references: describe what the user wants taken from each, and never invent details that would contradict them.
4. Write for the target model. Images: one coherent scene: subject and pose, outfit, environment, lighting, camera, framing and lens, image quality and style. Videos: the starting state, the action as a few beats that fit the duration, camera behaviour (state clearly whether it moves), sound (follow the user's wishes such as "no talking, no music"), and what must stay unchanged (identity, outfit, environment, framing).
5. Plain text only: sentences and short paragraphs; plain-text section labels like "CAMERA:" are fine. No markdown, no lists of alternatives, no notes to the user.
6. Length: images about 80–250 words, videos about 120–400 words, unless the user's prompt is already longer.
7. Answer with the rewritten prompt only.`;

export interface RefInfo { field: string; label: string; kind: string; name: string; primary: boolean; position: number }
export interface ElementInfo { name: string; description: string; photos: number }

/** The model and its settings as one line, e.g. "Wan 3.0 Prime (video): Duration 10 s, Aspect ratio 9:16". */
export function describeTarget(model: ModelInfo, settings: Record<string, unknown>) {
  const parts = model.fields
    .filter(f => !f.advanced && f.type !== 'text' && f.type !== 'string')
    .map(f => {
      const value = settings[f.key] ?? f.default;
      if (value === undefined || value === null || value === '') return null;
      const shown = f.optionLabels?.[String(value)] ?? (typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value));
      return `${f.label} ${shown}${f.unit && typeof value !== 'boolean' ? ` ${f.unit}` : ''}`;
    })
    .filter(Boolean);
  return `${model.name} (${model.modality})${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/** What each @ token is, so the rewriter keeps roles straight. */
export function tokenTable(refs: RefInfo[], elements: ElementInfo[]) {
  const lines: string[] = [];
  for (const r of refs) {
    lines.push(r.primary
      ? `- @image${r.position}: ${r.kind} ${r.position} in "${r.label}" (file "${r.name}")`
      : `- (no token) ${r.kind} attached as "${r.label}" (file "${r.name}"); it can't be mentioned with @`);
  }
  for (const e of elements) {
    lines.push(`- @${e.name}: element with ${e.photos} photo${e.photos === 1 ? '' : 's'}${e.description ? ` — ${e.description}` : ''}`);
  }
  return lines.length ? lines.join('\n') : '- none';
}

export function userMessage(opts: { target: string; refs: RefInfo[]; elements: ElementInfo[]; houseRules?: string; prompt: string; withImages: boolean }) {
  return [
    `Target model: ${opts.target}`,
    '',
    'References and tokens:',
    tokenTable(opts.refs, opts.elements),
    ...(opts.withImages ? ['', 'The attached images are those references, each labelled with its token.'] : []),
    ...(opts.houseRules?.trim() ? ['', 'The user\'s standing preferences (apply them unless this prompt says otherwise):', opts.houseRules.trim()] : []),
    '',
    'Prompt to rewrite:',
    '"""',
    opts.prompt.trim(),
    '"""',
  ].join('\n');
}

/** @ tokens in a text, normalised (lower case; @img2 / @ref2 count as @image2). */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const name = m[2].toLowerCase().replace(/^(?:img|ref)(\d+)$/, 'image$1');
    out.push(name);
  }
  return out;
}

/**
 * Compare tokens before and after a rewrite: every token the user wrote must still be there, and no new ones
 * may appear except references that exist (an attached @imageN the user didn't mention yet).
 */
export function checkTokens(original: string, rewritten: string, imageCount: number) {
  const before = new Set(tokens(original));
  const after = new Set(tokens(rewritten));
  const missing = [...before].filter(t => !after.has(t));
  const invented = [...after].filter(t => !before.has(t) && !(/^image(\d+)$/.test(t) && Number(t.slice(5)) >= 1 && Number(t.slice(5)) <= imageCount));
  return { missing, invented, ok: !missing.length && !invented.length };
}

/** The model's answer without wrapping it sometimes adds (code fences, quotes, a "Prompt:" label). */
export function cleanAnswer(text: string) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```$/, '').trim();
  s = s.replace(/^(?:rewritten\s+)?prompt\s*:\s*/i, '').trim();
  if (/^"""[\s\S]*"""$/.test(s)) s = s.slice(3, -3).trim();
  else if (/^"[^"]*"$/.test(s)) s = s.slice(1, -1).trim();
  return s;
}
