import { describe, expect, it } from 'vitest';
import { clampWait, mergePreset, modelDetails, modelSummary, pickOne, referenceSlots } from '../src/mcp/resolve.js';
import { allowsWorkspace, cleanPerms, cleanWorkspaces, hashToken, newToken, parseBearer, requirePerm } from '../src/services/apiTokens.js';
import type { ModelInfo } from '../src/providers/types.js';

describe('agent keys', () => {
  it('look like sst_… and are only accepted as Bearer tokens', () => {
    const token = newToken();
    expect(token).toMatch(/^sst_[\w-]{43}$/);
    expect(parseBearer(`Bearer ${token}`)).toBe(token);
    expect(parseBearer(`bearer  ${token} `)).toBe(token);
    expect(parseBearer(token)).toBeNull();
    expect(parseBearer('Bearer someone-elses-token')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).not.toContain(token.slice(4));
  });

  it('keep only known permissions and a clean workspace list', () => {
    expect(cleanPerms(['generate', 'save', 'admin', 'delete'])).toEqual(['generate', 'save', 'delete']);
    expect(cleanPerms('generate')).toEqual([]);
    expect(cleanWorkspaces(null)).toBeNull();
    expect(cleanWorkspaces([])).toEqual([]);
    expect(cleanWorkspaces(['x', '11111111-1111-1111-1111-111111111111'])).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('limit workspaces and actions', () => {
    expect(allowsWorkspace({ workspaceIds: null }, 'a')).toBe(true);
    expect(allowsWorkspace({ workspaceIds: ['a'] }, 'a')).toBe(true);
    expect(allowsWorkspace({ workspaceIds: ['a'] }, 'b')).toBe(false);
    expect(allowsWorkspace({ workspaceIds: [] }, 'a')).toBe(false);
    expect(() => requirePerm({ name: 'Bot', perms: ['generate'] }, 'generate')).not.toThrow();
    expect(() => requirePerm({ name: 'Bot', perms: ['generate'] }, 'delete')).toThrow(/isn't allowed to delete results/);
  });
});

describe('finding things by name', () => {
  const items = [
    { id: 'id-1', name: 'Mia' }, { id: 'id-2', name: 'Mia beach' }, { id: 'id-3', name: 'Ani Torosyan' },
  ];
  it('matches id, then exact name, then a unique partial name', () => {
    expect(pickOne(items, 'id-3', 'workspace').name).toBe('Ani Torosyan');
    expect(pickOne(items, 'mia', 'workspace').id).toBe('id-1');
    expect(pickOne(items, 'torosyan', 'workspace').id).toBe('id-3');
  });
  it('explains ambiguous or missing names', () => {
    expect(() => pickOne(items, 'ia', 'folder')).toThrow(/matches several folders/);
    expect(() => pickOne(items, 'Zoe', 'folder')).toThrow(/No folder called "Zoe". Choose from: "Mia"/);
    expect(() => pickOne([], 'Zoe', 'preset')).toThrow(/There are none yet/);
    expect(() => pickOne(items, '', 'workspace')).toThrow(/Say which workspace/);
  });
});

const model: ModelInfo = {
  id: 'auto:image.seedream-4.5.uncensored', providerId: 'auto', model: 'seedream', name: 'Seedream 4.5 · Uncensored', modality: 'image',
  fields: [{ key: 'aspect_ratio', label: 'Aspect', type: 'enum', options: ['1:1', '9:16'], default: '1:1' }],
  refFields: [
    { key: 'images', label: 'References', kind: 'image', max: 14, required: false, primary: true },
    { key: 'end', label: 'End frame', kind: 'image', max: 1, required: false },
  ],
  available: true, mature: true,
};

describe('describing models', () => {
  it('lists inputs compactly and in detail', () => {
    expect(modelSummary(model, { provider: 'Auto' })).toMatchObject({ uncensored: true, references: ['images (image ×14)', 'end (image)'] });
    expect(modelDetails(model, 'Auto').settings).toEqual([{ key: 'aspect_ratio', label: 'Aspect', type: 'enum', options: ['1:1', '9:16'], default: '1:1' }]);
  });
});

describe('generate arguments', () => {
  it('take references as a list for the main input or per input', () => {
    expect(referenceSlots(['Mia 1', 'Mia 2'], model)).toEqual({ images: ['Mia 1', 'Mia 2'] });
    expect(referenceSlots('Mia 1', model)).toEqual({ images: ['Mia 1'] });
    expect(referenceSlots({ end: 'Beach' }, model)).toEqual({ end: ['Beach'] });
    expect(() => referenceSlots({ start: ['x'] }, model)).toThrow(/Unknown reference input "start"/);
    expect(referenceSlots(undefined, model)).toEqual({});
  });

  it('start from a preset and let explicit arguments win', () => {
    const preset = { modelId: 'poyo:x', prompt: 'beach', settings: { aspect_ratio: '9:16', n: 1 }, refSlots: { images: ['r1'] }, folderId: 'f1', batch: 4 };
    const merged = mergePreset(preset, { prompt: 'city', settings: { aspect_ratio: '1:1' } });
    expect(merged).toMatchObject({ model: 'poyo:x', prompt: 'city', settings: { aspect_ratio: '1:1', n: 1 }, references: null, presetRefs: { images: ['r1'] }, presetFolderId: 'f1', batch: 4 });
    expect(mergePreset(null, { model: 'm' })).toMatchObject({ model: 'm', prompt: '', batch: 1 });
  });

  it('cap waiting', () => {
    expect(clampWait(undefined)).toBe(0);
    expect(clampWait(45.4)).toBe(45);
    expect(clampWait(9999)).toBe(300);
    expect(clampWait(-5)).toBe(0);
  });
});
