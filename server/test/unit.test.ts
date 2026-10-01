import { describe, expect, it } from 'vitest';
import { resolvePrompt } from '../src/services/prompt.js';
import { resolveInside, sanitizeRelativeDir } from '../src/services/exports.js';
import { friendlyError, normalizeSchema } from '../src/providers/spicyapi.js';
import { extractJobId, friendlyHiggsfieldError, presetRecommendation, findKey, mapJobState, normalizeHiggsfieldModel, parseToolResult } from '../src/providers/higgsfield.js';

describe('resolvePrompt', () => {
  const elements = [{ name: 'Mia', refIds: ['m1', 'm2'] }, { name: 'Hotel', refIds: ['h1', 'a1'] }];

  it('rewrites numbered mentions', () => {
    const r = resolvePrompt('put @image2 next to @image1', ['a1', 'a2'], []);
    expect(r.prompt).toBe('put image 2 next to image 1');
    expect(r.refs).toEqual(['a1', 'a2']);
  });

  it('expands elements after attached refs and dedupes', () => {
    const r = resolvePrompt('@mia in @Hotel lobby, style of @image1', ['a1'], elements);
    expect(r.refs).toEqual(['a1', 'm1', 'm2', 'h1']);
    expect(r.prompt).toBe('image 2, image 3 in image 4, image 1 lobby, style of image 1');
    expect(r.usedElements).toEqual(['mia', 'hotel']);
  });

  it('keeps repeated elements stable and leaves unknown mentions and emails alone', () => {
    const r = resolvePrompt('@Mia and @Mia again, mail me@x.com, hi @nobody', [], elements);
    expect(r.prompt).toBe('image 1, image 2 and image 1, image 2 again, mail me@x.com, hi @nobody');
    expect(r.refs).toEqual(['m1', 'm2']);
  });
});

describe('export paths', () => {
  it('sanitizes and blocks traversal', () => {
    expect(sanitizeRelativeDir(' mia\\images/ ')).toBe('mia/images');
    expect(() => sanitizeRelativeDir('../etc')).toThrow();
    expect(() => sanitizeRelativeDir('')).toThrow();
    expect(sanitizeRelativeDir('a/./b')).toBe('a/b');
    expect(() => resolveInside('/exports', '../x')).toThrow();
  });
});

describe('SpicyAPI schema normalization', () => {
  it('maps fields, refs and prompt by x-ui order', () => {
    const n = normalizeSchema({
      required: ['prompt', 'image_urls'],
      properties: {
        seed: { type: 'integer', minimum: 0, 'x-ui': { order: 5 } },
        prompt: { type: 'string', 'x-ui': { order: 1 } },
        image_urls: { type: 'array', maxItems: 4, items: { type: 'string' }, 'x-ui': { widget: 'multi-upload', order: 2 } },
        end_video: { type: 'string', 'x-ui': { widget: 'upload', order: 3 } },
        aspect_ratio: { enum: ['1:1', '9:16'], default: '1:1', 'x-ui': { order: 4 } },
        audio: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
      },
    });
    expect(n.promptField).toBe('prompt');
    expect(n.refFields.map(f => [f.key, f.label, f.kind, f.required, f.max])).toEqual([
      ['image_urls', 'References', 'image', true, 4],
      ['end_video', 'End video', 'video', false, 1],
    ]);
    expect(n.fields.map(f => [f.key, f.type])).toEqual([['aspect_ratio', 'enum'], ['audio', 'boolean']]);
  });
});

describe('SpicyAPI errors', () => {
  it('explains temporarily unsupported settings', () => {
    expect(friendlyError('This model cannot serve this parameter combination right now (enable_prompt_expansion=true: this model does not accept this value right now; enable_thinking=true: this model does not accept this value right now)'))
      .toBe("This model can't use Enable prompt expansion, Enable thinking right now. Turn them off in the settings and try again.");
    expect(friendlyError('image_urls: is required')).toBe('image_urls: is required');
  });
});

describe('SpicyAPI reference inputs', () => {
  it('treats web links as text, hides document uploads, keeps labels/units', () => {
    const n = normalizeSchema({
      properties: {
        reference_link_url: { type: 'string', format: 'uri', 'x-ui': { widget: 'text', placeholder: 'https://', order: 1 } },
        reference_file_url: { type: 'string', format: 'uri', 'x-ui': { widget: 'upload', order: 2 } },
        reference_image_urls: { type: 'array', items: { type: 'string', contentMediaType: ['image/png'] }, 'x-ui': { widget: 'multi-upload', primary: true, order: 3 } },
        reference_audio_urls: { type: 'array', items: { type: 'string', contentMediaType: ['audio/mpeg'] }, 'x-ui': { widget: 'multi-upload', order: 4 } },
        duration_seconds: { type: 'integer', enum: [-1, 5, 10], 'x-ui': { enum_labels: { '-1': 'Smart' }, unit: 's', order: 5 } },
        enable_thinking: { type: 'boolean', 'x-ui': { advanced: true, order: 6 } },
      },
    }, 'video');
    expect(n.refFields.map(f => [f.key, f.kind, f.primary])).toEqual([['reference_image_urls', 'image', true], ['reference_audio_urls', 'audio', false]]);
    const link = n.fields.find(f => f.key === 'reference_link_url')!;
    expect([link.type, link.label, link.placeholder]).toEqual(['string', 'Reference link', 'https://']);
    const duration = n.fields.find(f => f.key === 'duration_seconds')!;
    expect([duration.optionLabels, duration.unit]).toEqual([{ '-1': 'Smart' }, 's']);
    expect(n.fields.find(f => f.key === 'enable_thinking')!.advanced).toBe(true);
  });
});

describe('SpicyAPI video frame fields', () => {
  it('names start/end frames and orders start first', () => {
    const n = normalizeSchema({
      required: ['image_url'],
      properties: {
        last_image_url: { type: 'string', description: 'closing frame', 'x-ui': { widget: 'upload', order: 85 } },
        image_url: { type: 'string', description: 'opening frame', 'x-ui': { widget: 'upload', order: 90 } },
      },
    }, 'video');
    expect(n.refFields.map(f => [f.key, f.label, f.required, f.description])).toEqual([
      ['image_url', 'Start frame', true, 'opening frame'],
      ['last_image_url', 'End frame', false, 'closing frame'],
    ]);
  });
});

describe('Higgsfield MCP helpers', () => {
  it('normalizes a catalog item', () => {
    const m = normalizeHiggsfieldModel({
      id: 'seedream_v4_5', name: 'Seedream 4.5', provider_name: 'Bytedance', output_type: 'image',
      parameters: [{ name: 'quality', type: 'string', options: ['basic', 'high'], default: 'basic' }, { name: 'folder_id', type: 'string' }],
      medias: [{ name: 'medias', type: 'image', roles: ['image_references'] }],
      aspect_ratios: ['1:1', '9:16'],
    });
    expect(m.id).toBe('higgsfield:seedream_v4_5');
    expect(m.fields.map(f => f.key)).toEqual(['aspect_ratio', 'quality']);
    expect(m.fields[0].default).toBe('9:16');
    expect(m.refFields).toEqual([{ key: 'image_references', label: 'References', kind: 'image', max: 14, required: false }]);
  });

  it('parses tool results and finds nested keys', () => {
    expect(parseToolResult({ content: [{ type: 'text', text: '{"credits":277}' }] })).toEqual({ credits: 277 });
    expect(() => parseToolResult({ isError: true, content: [{ type: 'text', text: 'nope' }] })).toThrow('nope');
    expect(findKey({ a: { jobs: [{ job_id: 'x' }] } }, ['job_id'])).toBe('x');
    expect(mapJobState('nsfw')).toBe('failed');
    expect(mapJobState('in_progress')).toBe('running');
    expect(mapJobState('completed')).toBe('succeeded');
    expect(mapJobState('lookup_failed')).toBe('failed');
    expect(friendlyHiggsfieldError('Error starting generation: Request failed with status 503 Service Unavailable\nRequest ID: x'))
      .toMatch(/temporarily unavailable/);
    expect(friendlyHiggsfieldError('wan3_0 backend request failed (422): params failed validation [{"type":"value_error","loc":[],"msg":"Value error, start_image/end_image cannot be combined with reference media","input":{}}]'))
      .toBe('This model takes either a Start/End frame or References, not both. Remove one of them and try again.');
    expect(friendlyHiggsfieldError('failed validation [{"msg":"duration must be <= 15"}]')).toBe('Higgsfield rejected the settings: duration must be <= 15.');
    // Only explicit job ids: other ids in the reply (presets, folders, media) must not be used.
    expect(extractJobId({ job_id: 'j1' })).toBe('j1');
    expect(extractJobId({ jobs: [{ id: 'j2', status: 'queued' }] })).toBe('j2');
    expect(extractJobId({ recommended_preset: { id: 'p1' }, folder: { id: 'f1' } })).toBeUndefined();
    // Real generate_* reply shape.
    expect(extractJobId({ results: [{ id: 'r1', type: 'video', status: 'queued' }], cost: { credits: 10 } })).toBe('r1');
    // Preset question instead of a job: its id is declined on a retry.
    const presetReply = { notice: { type: 'preset_recommendation', message: 'This prompt looks like the Higgsfield preset "IN THE DARK".', data: { id: 'p-dark' } } };
    expect(extractJobId(presetReply)).toBeUndefined();
    expect(presetRecommendation(presetReply)).toBe('p-dark');
    // Real reply shape from Higgsfield.
    expect(presetRecommendation({ notice: { type: 'preset_recommendation', message: 'looks like the Higgsfield preset', data: {
      preset: { id: 'p1', name: 'IN THE DARK' }, use_preset_with: { model: 'higgsfield_preset', preset_id: 'p1' }, retry_literal_with: { declined_preset_id: 'p1' },
    } } })).toBe('p1');
    expect(presetRecommendation({ notice: { type: 'info', message: 'Adjusted duration', data: { id: 'x' } } })).toBeUndefined();
    const wan = normalizeHiggsfieldModel({ id: 'wan3_0', output_type: 'video', parameters: [
      { name: 'duration', type: 'number', min: -1, max: 30, default: 5, description: 'Duration in seconds (2-30), or -1 to let the model choose the length.' },
      { name: 'guidance', type: 'number', min: 0, max: 1 },
    ] });
    expect(wan.fields.find(f => f.key === 'duration')).toMatchObject({ type: 'integer', step: 1, unit: 's', min: 2, max: 30, optionLabels: { '-1': 'Smart' } });
    expect(wan.fields.find(f => f.key === 'guidance')).toMatchObject({ type: 'number', min: 0, max: 1 });
    const start = normalizeHiggsfieldModel({ id: 'wan', output_type: 'video', medias: [{ type: 'image', roles: ['start_image', 'image_references'] }] });
    expect(start.refFields.map(f => [f.key, f.max])).toEqual([['start_image', 1], ['image_references', 14]]);
  });
});

describe('fitImageUnder', () => {
  it('shrinks large images under the limit and keeps small ones untouched', async () => {
    const { default: sharp } = await import('sharp');
    const { fitImageUnder } = await import('../src/services/media.js');
    // Random noise compresses badly, so this PNG is several MB.
    const raw = Buffer.alloc(2000 * 2000 * 3).map(() => Math.floor(Math.random() * 256));
    const big = await sharp(raw, { raw: { width: 2000, height: 2000, channels: 3 } }).png().toBuffer();
    const limit = 1024 * 1024;
    expect(big.length).toBeGreaterThan(limit);
    const out = await fitImageUnder(big, 'image/png', limit);
    expect(out.bytes.length).toBeLessThanOrEqual(limit);
    expect(out.mime).toBe('image/jpeg');
    const small = Buffer.from('tiny');
    expect((await fitImageUnder(small, 'image/png', limit)).bytes).toBe(small);
  }, 60_000);
});

describe('metadata stripping', () => {
  it.each(['jpeg', 'png', 'webp'] as const)('removes EXIF/XMP from %s without touching pixels', async format => {
    const { default: sharp } = await import('sharp');
    const { stripImage } = await import('../src/services/metadata.js');
    const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>AI Generator</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';
    const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c86432' } })
      .withExif({ IFD0: { Copyright: 'secret', Software: 'GenModel' } })
      .withXmp(xmp)
      .toFormat(format)
      .toBuffer();
    const before = await sharp(source).metadata();
    expect(before.exif || before.xmp).toBeTruthy();

    const stripped = stripImage(source, `image/${format}`)!;
    const after = await sharp(stripped).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(stripped.includes(Buffer.from('secret'))).toBe(false);
    expect(stripped.includes(Buffer.from('AI Generator'))).toBe(false);
    const [a, b] = await Promise.all([sharp(source).raw().toBuffer(), sharp(stripped).raw().toBuffer()]);
    expect(b.equals(a)).toBe(true);
  });
});

describe('multi-user helpers', () => {
  it('encrypts secrets and rejects the wrong key', async () => {
    const { encrypt, decrypt, sealJson, openJson, setKeyForTests } = await import('../src/services/secrets.js');
    const { randomBytes } = await import('node:crypto');
    setKeyForTests(randomBytes(32));
    const sealed = encrypt('sk-spicy-secret');
    expect(sealed).not.toContain('sk-spicy');
    expect(decrypt(sealed)).toBe('sk-spicy-secret');
    const box = sealJson({ apiKey: 'abc' });
    expect(JSON.stringify(box)).not.toContain('abc');
    expect(openJson(box)).toEqual({ apiKey: 'abc' });
    expect(openJson({ apiKey: 'legacy' })).toEqual({ apiKey: 'legacy' }); // pre-encryption rows still read
    setKeyForTests(randomBytes(32));
    expect(() => decrypt(sealed)).toThrow();
    setKeyForTests(undefined);
  });

  it('hashes with argon2id and still accepts legacy scrypt hashes', async () => {
    const { hashPassword, verifyPassword, needsRehash } = await import('../src/auth.js');
    const hash = await hashPassword('correct horse');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    const { scryptSync, randomBytes } = await import('node:crypto');
    const salt = randomBytes(16);
    const legacy = `scrypt$${salt.toString('hex')}$${scryptSync('old pass', salt, 64).toString('hex')}`;
    expect(await verifyPassword('old pass', legacy)).toBe(true);
    expect(await verifyPassword('nope', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(hash)).toBe(false);
  });

  it('parses SMB shares and explains SMB errors', async () => {
    const { parseShare, smbError, normaliseTarget } = await import('../src/services/saveTargets.js');
    expect(parseShare('//192.168.1.10/ai/Pictures')).toEqual({ host: '192.168.1.10', share: 'ai', path: 'Pictures' });
    expect(parseShare(String.raw`\\nas\media`)).toEqual({ host: 'nas', share: 'media', path: '' });
    expect(parseShare('nas')).toBeNull();
    expect(smbError('session setup failed: NT_STATUS_LOGON_FAILURE')).toMatch(/login failed/);
    expect(smbError('tree connect failed: NT_STATUS_BAD_NETWORK_NAME')).toMatch(/share name/);
    // An empty password keeps the stored one for the same share; a different share needs a new one.
    const prev = { type: 'smb' as const, host: 'nas', share: 'ai', path: '', username: 'u', password: 'secret' };
    expect(normaliseTarget({ type: 'smb', host: 'nas', share: 'ai', path: 'x/../y' === '' ? '' : 'Pictures', username: 'u', password: '' }, prev))
      .toMatchObject({ password: 'secret', path: 'Pictures' });
    expect(normaliseTarget({ type: 'smb', host: 'other', share: 'ai', username: 'u', password: '' }, prev)).toMatchObject({ password: '' });
    expect(() => normaliseTarget({ type: 'local', path: '../etc' }, null)).toThrow();
  });
});

describe('native elements', () => {
  it('keeps @element mentions for providers that take elements themselves', () => {
    const elements = [{ name: 'Mia', refIds: ['a', 'b'] }];
    const native = resolvePrompt('@mia walks in, see @image1', ['x'], elements, true);
    expect(native.prompt).toBe('@Mia walks in, see image 1');
    expect(native.refs).toEqual(['x']);
    expect(native.usedElements).toEqual(['mia']);
    const attached = resolvePrompt('@mia walks in', ['x'], elements);
    expect(attached.prompt).toBe('image 2, image 3 walks in');
    expect(attached.refs).toEqual(['x', 'a', 'b']);
  });

  it('detects Kling O3 style elements in a SpicyAPI schema', () => {
    const schema = {
      properties: {
        prompt: { type: 'string' },
        resolution: { type: 'string', enum: ['720p', '1080p', '4k'] },
        elements: { type: 'array', maxItems: 7, description: '4K only.', items: { type: 'object', properties: { name: { type: 'string' }, image_urls: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', format: 'uri' } } } } },
      },
    };
    expect(normalizeSchema(schema, 'video').nativeElements).toEqual({ max: 7, minImages: 2, maxImages: 4, note: '4K only.', requiresSetting: { key: 'resolution', value: '4k' } });
    expect(normalizeSchema({ properties: { prompt: { type: 'string' } } }, 'video').nativeElements).toBeUndefined();
  });

  it('marks Higgsfield models that take Elements', () => {
    const kling = normalizeHiggsfieldModel({ id: 'kling3_0', name: 'Kling v3.0', output_type: 'video', medias: [{ type: 'image', roles: ['start_image', 'end_image'] }] });
    expect(kling.nativeElements?.requiresRef).toBe('start_image');
    expect(normalizeHiggsfieldModel({ id: 'kling2_6', output_type: 'video' }).nativeElements).toBeUndefined();
  });
});

describe('SpicyAPI single-item list inputs', () => {
  it('remembers that a one-item input is still a list', () => {
    const { refFields } = normalizeSchema({ properties: {
      image_urls: { type: 'array', maxItems: 1, items: { type: 'string', format: 'uri' } },
      image_url: { type: 'string', format: 'uri' },
    } }, 'image');
    expect(refFields.find(f => f.key === 'image_urls')).toMatchObject({ max: 1, array: true });
    expect(refFields.find(f => f.key === 'image_url')?.array).toBeUndefined();
  });
});
