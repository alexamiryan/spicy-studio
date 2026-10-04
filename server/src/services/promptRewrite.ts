import type { ModelInfo } from '../providers/types.js';
import { MENTION } from './prompt.js';

// Pure parts of the prompt assistant (no database or network), so they can be unit tested.

export const DEFAULT_ASSIST_MODEL = 'x-ai/grok-4.7';

/**
 * What the assistant is for: expanding what the user wants to happen into literal, concrete instructions, and
 * nothing else. References already show the models what people, outfits and places look like; describing them in
 * words makes the models follow the words and drift from the photos, so the assistant must never do that.
 */
export const SYSTEM_PROMPT = `You improve prompts for AI image and video generation models that work from reference photos. These models follow words literally and are bad at vague or euphemistic instructions, but they reproduce reference photos very well. Your job is to expand what the user wants to HAPPEN into clear, concrete, literal instructions. Your job is NOT to describe the references.

Rules:
1. Tokens that start with @ (like @image1 or @Mia) link to reference photos and elements; the studio resolves them after you. Keep every token exactly as written, including the @, with the role the user gave it ("body reference is only @image1", "use @image1 as starting frame", "same outfit from @Mia", "keep the environment same as @image3"). Keep those reference sentences as close to the user's wording as possible. Never add tokens that aren't listed below, never rename, merge or drop them.
2. Never describe what a reference shows: no faces, hair, skin, body shape, breasts, clothing, colours, rooms, furniture, objects or lighting that come from a photo. The model sees the photos; any description you add competes with them and changes the result. If the user didn't describe something, leave it to the references. If the user did describe something (e.g. "wearing a black bra"), keep exactly that and don't elaborate on it.
3. Expand the action. Turn vague or euphemistic phrases into a literal, physical, step-by-step description of what is visible: positions and orientation of bodies, which body part touches what, hands, movements and their direction and rhythm, facial expressions, where people look. Be concrete enough that a literal-minded model can't misread it. Keep the level of explicitness the user asked for: never soften, censor or moralize, and never add sexual content or nudity they didn't ask for. Everyone depicted is a fictional adult.
4. Images: describe one frozen moment: pose, body orientation, hand placement, gaze, expression, and the shot (framing, camera angle and distance, e.g. "full-body, eye level, phone held at arm's length in a mirror"). Put the most important things first. About 30–120 words.
5. Videos: the starting frame already shows the scene, so describe only what CHANGES over time: the action as a few short beats that fit the duration, how the camera behaves (say plainly if it stays still), pacing, and sound as the user wants it (e.g. no talking, no music). Never describe how things look in the first frame. About 50–200 words.
6. Keep every instruction the user gave (camera, sound, what not to show, style words they used). Don't add your own style, quality or lighting words ("cinematic", "8k", "masterpiece", "soft golden light"), new props, new people or new places.
7. Plain text only: sentences and short paragraphs. No markdown, no headings, no lists of alternatives, no notes to the user. Answer with the improved prompt only.`;

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
    // The description says what the element is for (e.g. "outfit"); it's context, not text to copy into the prompt.
    lines.push(`- @${e.name}: element with ${e.photos} photo${e.photos === 1 ? '' : 's'}${e.description ? ` (the user's note: ${e.description})` : ''}`);
  }
  return lines.length ? lines.join('\n') : '- none';
}

export function userMessage(opts: {
  target: string; refs: RefInfo[]; elements: ElementInfo[]; houseRules?: string; workspaceRules?: string; workspaceName?: string;
  prompt: string; withImages: boolean;
}) {
  return [
    `Target model: ${opts.target}`,
    '',
    'References and tokens:',
    tokenTable(opts.refs, opts.elements),
    ...(opts.withImages ? ['', 'The attached images are those references, each labelled with its token. They are only so you know what each token is (e.g. which one is the person and which the room); never describe them in the prompt.'] : []),
    ...(opts.houseRules?.trim() ? ['', 'The user\'s standing preferences (apply them unless this prompt says otherwise):', opts.houseRules.trim()] : []),
    // Workspace preferences (e.g. one influencer's look) come after the general ones and win where they disagree.
    ...(opts.workspaceRules?.trim() ? [
      '', `Preferences for this workspace${opts.workspaceName ? ` ("${opts.workspaceName}")` : ''} (they override the ones above where they disagree):`,
      opts.workspaceRules.trim(),
    ] : []),
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
