import { describe, expect, it, vi } from 'vitest';

// The provider reads the user's API key from the database: stub it.
vi.mock('../src/services/providerSettings.js', () => ({
  getProviderRow: async () => ({ credentials: { apiKey: 'test-key' }, state: {}, enabled: true }),
}));
const { PoyoProvider, estimateCredits } = await import('../src/providers/poyo.js');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('PoYo catalog', () => {
  const poyo = new PoyoProvider('u');

  it('lists image and video models built from the bundled catalog', async () => {
    const images = await poyo.listModels('image');
    const videos = await poyo.listModels('video');
    expect(images.length).toBeGreaterThan(20);
    expect(videos.length).toBeGreaterThan(20);
    expect(images.every(m => m.providerId === 'poyo' && m.id === `poyo:${m.model}`)).toBe(true);
  });

  it('shapes variants: plain model has no image input, -edit requires one, n is hidden', async () => {
    const plain = await poyo.getModel('seedream-4.5');
    const edit = await poyo.getModel('seedream-4.5-edit');
    expect(plain.name).toBe('Seedream 4.5 · Standard');
    expect(edit.name).toBe('Seedream 4.5 · Edit');
    expect(plain.refFields).toEqual([]);
    expect(edit.refFields.find(f => f.key === 'image_urls')).toMatchObject({ required: true, kind: 'image' });
    expect(edit.fields.some(f => f.key === 'n')).toBe(false);
    // `size` is a preset list (the docs also allow WxH and objects)
    expect(plain.fields.find(f => f.key === 'size')).toMatchObject({ type: 'enum' });
  });

  it('text-to-video variants take no media; image-to-video requires the start image', async () => {
    const t2v = await poyo.getModel('wan3.0-text-to-video');
    const i2v = await poyo.getModel('wan3.0-image-to-video');
    expect(t2v.refFields).toEqual([]);
    expect(i2v.refFields.find(f => f.key === 'image_urls')?.required).toBe(true);
  });

  it('estimates credits from published tiers (per second × duration)', async () => {
    expect(estimateCredits('seedream-4.5', {})).toBe(5);
    expect(estimateCredits('seedream-4.5-edit', {})).toBe(5); // priced like its base model
    const perSecond = estimateCredits('kling-3.0-turbo/standard', { duration: 5 });
    expect(perSecond).toBe(17 * 5);
    expect(estimateCredits('no-such-model', {})).toBeNull();
  });
});

describe('PoYo API calls', () => {
  it('submits {model, input} and reads the task id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json({ code: 200, data: { task_id: 'task-1', status: 'not_started' } });
    }) as unknown as typeof fetch;
    const poyo = new PoyoProvider('u', fetchFn);
    const res = await poyo.create({
      model: 'seedream-4.5-edit', modality: 'image', prompt: 'snow', settings: { size: '9:16' },
      refs: { image_urls: ['https://storage.poyo.ai/a.png'] }, idempotencyKey: 'k',
    });
    expect(res).toEqual({ taskId: 'task-1', state: 'queued' });
    expect(calls[0].url).toBe('https://api.poyo.ai/api/generate/submit');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'seedream-4.5-edit', input: { size: '9:16', prompt: 'snow', image_urls: ['https://storage.poyo.ai/a.png'] },
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  it('maps task status, files and failures', async () => {
    const replies = [
      { code: 200, data: { status: 'running', files: [], progress: 40 } },
      { code: 200, data: { status: 'finished', credits_amount: 5, files: [{ file_url: 'https://x/y.jpg', file_type: 'image' }] } },
      { code: 200, data: { status: 'failed', files: [], error_message: 'The prompt violates our content policy' } },
    ];
    const poyo = new PoyoProvider('u', (async () => json(replies.shift())) as unknown as typeof fetch);
    expect((await poyo.task('t')).state).toBe('running');
    expect(await poyo.task('t')).toMatchObject({ state: 'succeeded', cost: 5, assets: [{ url: 'https://x/y.jpg' }] });
    expect(await poyo.task('t')).toMatchObject({ state: 'failed', error: 'The prompt violates our content policy' });
  });

  it('turns API errors into readable messages', async () => {
    const bad = new PoyoProvider('u', (async () => json({ code: 401, error: { message: 'Invalid API key', type: 'authentication_error' } }, 401)) as unknown as typeof fetch);
    await expect(bad.balance()).rejects.toThrow(/rejected the API key/);
    const invalid = new PoyoProvider('u', (async () => json({ code: 400, error: { message: 'prompt is required', type: 'validation_error' } }, 400)) as unknown as typeof fetch);
    await expect(invalid.create({ model: 'z-image', modality: 'image', settings: {}, refs: {}, idempotencyKey: 'k' })).rejects.toThrow('prompt is required');
  });

  it('reads the credit balance', async () => {
    const poyo = new PoyoProvider('u', (async () => json({ code: 200, data: { email: 'a@b.c', credits_amount: 17276 } })) as unknown as typeof fetch);
    expect(await poyo.balance()).toEqual({ amount: 17276, unit: 'credits' });
  });
});
