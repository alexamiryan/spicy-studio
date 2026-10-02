import { describe, expect, it } from 'vitest';
import { autoModel, familyKey, familyName, refRoles, translateRefs, translateSettings, usd, type Family } from '../src/services/router.js';
import type { ModelInfo } from '../src/providers/types.js';

const model = (over: Partial<ModelInfo>): ModelInfo => ({
  id: 'p:m', providerId: 'p', model: 'm', name: 'M', modality: 'image', fields: [], refFields: [], available: true, ...over,
});

describe('families', () => {
  it('groups the same model across providers by name', () => {
    expect(familyName({ name: 'Seedream 4.5' })).toBe('seedream 4.5');
    expect(familyName({ name: 'Seedream 4.5 · Edit' })).toBe('seedream 4.5');
    expect(familyName({ name: 'Wan 3.0 Prime · Image to Video' })).toBe(familyName({ name: 'Wan 3.0 Prime' }));
    expect(familyName({ name: 'Kling v3' })).toBe(familyName({ name: 'Kling 3.0 · Standard' }));
    expect(familyName({ name: 'Google Veo 3.1' })).toBe(familyName({ name: 'Veo 3.1 · Fast' }));
    expect(familyName({ name: 'Wan 2.6 Video' })).toBe(familyName({ name: 'Wan 2.6 · Text to Video' }));
  });

  it('never routes special-purpose variants', () => {
    expect(familyName({ name: 'Kling 2.6 · Motion Control' })).toBeNull();
    expect(familyName({ name: 'Seedream 5.0 Pro · Layer Decomposition' })).toBeNull();
    expect(familyName({ name: 'FLUX 3 · Extend video' })).toBeNull();
  });

  it('builds stable keys', () => {
    expect(familyKey('image', 'seedream 4.5')).toBe('image.seedream-4.5');
  });
});

const higgs = model({
  id: 'higgsfield:seedream', providerId: 'higgsfield', name: 'Seedream 4.5',
  fields: [{ key: 'aspect_ratio', label: 'Aspect', type: 'enum', options: ['1:1', '9:16', '16:9'], default: '1:1' }],
  refFields: [{ key: 'image_references', label: 'References', kind: 'image', max: 14, required: false }],
});
const poyoT2i = model({
  id: 'poyo:seedream-4.5', providerId: 'poyo', name: 'Seedream 4.5 · Standard',
  fields: [{ key: 'size', label: 'Size', type: 'enum', options: ['2K', '4K', '1:1', '3:4', '9:16', '2:3'], default: '1:1' }],
  refFields: [],
});
const poyoEdit = model({
  id: 'poyo:seedream-4.5-edit', providerId: 'poyo', name: 'Seedream 4.5 · Edit',
  fields: poyoT2i.fields,
  refFields: [{ key: 'image_urls', label: 'References', kind: 'image', max: 10, required: true }],
});

describe('translating the create box', () => {
  it('maps the aspect ratio to each model (closest when missing)', () => {
    expect(translateSettings(poyoT2i, { aspect_ratio: '9:16' })).toEqual({ size: '9:16' });
    expect(translateSettings(higgs, { aspect_ratio: '2:3' })).toEqual({ aspect_ratio: '9:16' });
  });

  it('maps duration, resolution and audio for video models', () => {
    const video = model({
      modality: 'video', fields: [
        { key: 'duration', label: 'Duration', type: 'enum', options: [5, 10] },
        { key: 'resolution', label: 'Resolution', type: 'enum', options: ['480p', '1080p'] },
        { key: 'sound', label: 'Sound', type: 'boolean' },
      ],
    });
    expect(translateSettings(video, { duration: 8, resolution: '720p', audio: true })).toEqual({ duration: 10, resolution: '480p', sound: true });
  });

  it('routes references to the right input and rejects models that cannot take them', () => {
    expect(translateRefs(higgs, { images: ['a', 'b'] })).toEqual({ image_references: ['a', 'b'] });
    expect(translateRefs(poyoEdit, { images: ['a'] })).toEqual({ image_urls: ['a'] });
    expect(translateRefs(poyoT2i, { images: ['a'] })).toBeNull(); // takes no references
    expect(translateRefs(poyoEdit, {})).toBeNull(); // edit needs references
    expect(translateRefs(poyoT2i, {})).toEqual({});
  });

  it('finds start and end frames', () => {
    const i2v = model({ modality: 'video', refFields: [
      { key: 'image_url', label: 'Start', kind: 'image', max: 1, required: true },
      { key: 'last_image_url', label: 'End', kind: 'image', max: 1, required: false },
    ] });
    const roles = refRoles(i2v);
    expect(roles.start?.key).toBe('image_url');
    expect(roles.end?.key).toBe('last_image_url');
    expect(translateRefs(i2v, { start: ['s'], end: ['e'] })).toEqual({ image_url: ['s'], last_image_url: ['e'] });
  });
});

describe('the Auto model', () => {
  it('offers the shared settings and inputs', () => {
    const family: Family = { key: 'image.seedream-4.5', name: 'Seedream 4.5', modality: 'image', candidates: [
      { provider: { name: 'Higgsfield' } as any, model: higgs },
      { provider: { name: 'PoYo' } as any, model: poyoT2i },
      { provider: { name: 'PoYo' } as any, model: poyoEdit },
    ] };
    const auto = autoModel(family);
    expect(auto.id).toBe('auto:image.seedream-4.5');
    expect(auto.fields.find(f => f.key === 'aspect_ratio')).toMatchObject({ default: '9:16' });
    expect(auto.refFields).toEqual([expect.objectContaining({ key: 'images', max: 14, primary: true })]);
    expect(auto.description).toBe('Cheapest of Higgsfield, PoYo with enough balance');
  });

  it('compares prices in dollars', () => {
    expect(usd({ amount: 0.03, unit: 'USD' }, { id: 'spicyapi' }, {})).toBe(0.03);
    expect(usd({ amount: 5, unit: 'credits' }, { id: 'poyo', unitValueUsd: 0.005 }, {})).toBeCloseTo(0.025);
    expect(usd({ amount: 10, unit: 'credits' }, { id: 'higgsfield' }, { higgsfield: 0.04 })).toBeCloseTo(0.4);
  });
});
