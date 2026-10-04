import { describe, expect, it } from 'vitest';
import { checkTokens, cleanAnswer, describeTarget, SYSTEM_PROMPT, tokenTable, tokens, userMessage } from '../src/services/promptRewrite.js';
import type { ModelInfo } from '../src/providers/types.js';

describe('prompt assistant tokens', () => {
  it('finds @ tokens like the studio does (aliases normalised, e-mails ignored)', () => {
    expect(tokens('Use @image1 as start, outfit from @AgentProvocateur4 and @img2, mail me@x.com')).toEqual(['image1', 'agentprovocateur4', 'image2']);
    expect(tokens('wearing @ysl-OPYUM-Sandals .')).toEqual(['ysl-opyum-sandals']);
  });

  it('accepts rewrites that keep every token', () => {
    const original = 'Body reference is only @image1 and @image2. Outfit from @image3 and @bordelle-nara-ysl-sandals.';
    const rewritten = 'Use @image1 and @image2 strictly as the body reference. She wears the exact outfit shown in @image3 together with @Bordelle-Nara-YSL-Sandals.';
    expect(checkTokens(original, rewritten, 3)).toEqual({ missing: [], invented: [], ok: true });
  });

  it('flags dropped and invented tokens', () => {
    const r = checkTokens('Start from @image1, outfit @Mia', 'Start from @image1 and keep the scene of @image5, outfit @Zoe', 3);
    expect(r.missing).toEqual(['mia']);
    expect(r.invented).toEqual(['image5', 'zoe']);
    expect(r.ok).toBe(false);
  });

  it('allows mentioning an attached reference the user had not mentioned yet', () => {
    expect(checkTokens('Girl at home', 'Girl at home, environment as in @image2', 2).ok).toBe(true);
    expect(checkTokens('Girl at home', 'Girl at home, environment as in @image3', 2).ok).toBe(false);
  });

  it('strips wrapping from answers', () => {
    expect(cleanAnswer('```\nA woman stands.\n```')).toBe('A woman stands.');
    expect(cleanAnswer('Prompt: A woman stands.')).toBe('A woman stands.');
    expect(cleanAnswer('"A woman stands."')).toBe('A woman stands.');
    expect(cleanAnswer('"""\nShe says "hi" here.\n"""')).toBe('She says "hi" here.');
  });
});

describe('what the assistant is told', () => {
  it('expands the action and never describes the references', () => {
    expect(SYSTEM_PROMPT).toMatch(/NOT to describe the references/);
    expect(SYSTEM_PROMPT).toMatch(/Never describe what a reference shows/);
    expect(SYSTEM_PROMPT).toMatch(/Expand the action/);
    expect(SYSTEM_PROMPT).toMatch(/describe only what CHANGES over time/);
    expect(userMessage({ target: 'X', refs: [], elements: [], prompt: 'p', withImages: true })).toContain('never describe them in the prompt');
  });

  const model: ModelInfo = {
    id: 'auto:video.wan-3-prime.uncensored', providerId: 'auto', model: 'x', name: 'Wan 3.0 Prime · Uncensored', modality: 'video', available: true,
    fields: [
      { key: 'duration', label: 'Duration', type: 'enum', options: [5, 10], default: 5, unit: 's' },
      { key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', options: ['9:16'], default: '9:16' },
      { key: 'audio', label: 'Audio', type: 'boolean', default: true },
      { key: 'seed', label: 'Seed', type: 'integer', advanced: true },
    ],
    refFields: [],
  };

  it('describes the target with its settings', () => {
    expect(describeTarget(model, { duration: 10, audio: false })).toBe('Wan 3.0 Prime · Uncensored (video): Duration 10 s, Aspect ratio 9:16, Audio off');
  });

  it('lists every token and what it is', () => {
    const table = tokenTable([
      { field: 'images', label: 'References', kind: 'photo', name: 'face', primary: true, position: 1 },
      { field: 'start', label: 'Start frame', kind: 'photo', name: 'room', primary: false, position: 1 },
    ], [{ name: 'Mia', description: 'red dress', photos: 3 }]);
    expect(table).toContain('- @image1: photo 1 in "References"');
    expect(table).toContain('attached as "Start frame"');
    expect(table).toContain("- @Mia: element with 3 photos (the user's note: red dress)");
  });

  it('adds the workspace preferences after the general ones', () => {
    const msg = userMessage({ target: 'X (image)', refs: [], elements: [], houseRules: 'Amateur iPhone look.', workspaceRules: 'Ani: freckles, no makeup.', workspaceName: 'Ani Torosyan', prompt: 'p', withImages: false });
    expect(msg.indexOf('Amateur iPhone look.')).toBeLessThan(msg.indexOf('Ani: freckles'));
    expect(msg).toContain('Preferences for this workspace ("Ani Torosyan") (they override');
    expect(userMessage({ target: 'X', refs: [], elements: [], workspaceRules: '  ', prompt: 'p', withImages: false })).not.toContain('this workspace');
  });

  it('includes house rules and the prompt', () => {
    const msg = userMessage({ target: 'X (image)', refs: [], elements: [], houseRules: 'No talking. No music.', prompt: ' girl at home ', withImages: false });
    expect(msg).toContain('standing preferences');
    expect(msg).toContain('"""\ngirl at home\n"""');
  });
});
