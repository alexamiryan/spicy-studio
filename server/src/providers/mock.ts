import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ProviderError, type CreateRequest, type Modality, type ModelInfo, type Provider, type TaskResult } from './types.js';

/** Development-only provider (MOCK_PROVIDER=1): exercises the whole pipeline without spending credits. */
const MODELS: ModelInfo[] = [
  {
    id: 'mock:mock-image', providerId: 'mock', model: 'mock-image', name: 'Mock Image', vendor: 'Test', modality: 'image',
    description: 'Returns a solid-colour image after a few seconds.', promptField: 'prompt', available: true, price: 'free',
    fields: [
      { key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', options: ['1:1', '3:4', '9:16', '16:9'], default: '9:16' },
      { key: 'quality', label: 'Quality', type: 'enum', options: ['basic', 'high'], default: 'basic' },
      { key: 'fail', label: 'Fail on purpose', type: 'boolean', default: false },
    ],
    refFields: [{ key: 'image_references', label: 'References', kind: 'image', max: 6, required: false }],
  },
  {
    id: 'mock:mock-video', providerId: 'mock', model: 'mock-video', name: 'Mock Video', vendor: 'Test', modality: 'video',
    description: 'Needs a start frame; returns an image as a stand-in.', promptField: 'prompt', available: true, price: 'free',
    fields: [{ key: 'duration', label: 'Duration (s)', type: 'enum', options: [5, 10], default: 5 }],
    refFields: [
      { key: 'start_image', label: 'Start frame', kind: 'image', max: 1, required: true },
      { key: 'end_image', label: 'End frame', kind: 'image', max: 1, required: false },
    ],
  },
  {
    // Mirrors a busy model (Wan 3.0 Prime reference-to-video) to exercise the create box layout.
    id: 'mock:mock-ref-video', providerId: 'mock', model: 'mock-ref-video', name: 'Mock Reference Video', vendor: 'Test', modality: 'video',
    description: 'Many settings and reference inputs.', promptField: 'prompt', available: true, price: 'free',
    fields: [
      { key: 'enable_prompt_expansion', label: 'Enable prompt expansion', type: 'boolean', default: false },
      { key: 'generate_audio', label: 'Generate audio', type: 'boolean', default: true },
      { key: 'duration_seconds', label: 'Duration seconds', type: 'enum', options: [-1, ...Array.from({ length: 29 }, (_, i) => i + 2)], default: 5, optionLabels: { '-1': 'Smart' }, unit: 's' },
      { key: 'resolution', label: 'Resolution', type: 'enum', options: ['480p', '720p', '1080p'], default: '720p' },
      { key: 'enable_thinking', label: 'Enable thinking', type: 'boolean', default: false, advanced: true },
      { key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], default: '9:16' },
      { key: 'reference_link', label: 'Reference link', type: 'string', placeholder: 'https://' },
    ],
    refFields: [
      { key: 'reference_image_urls', label: 'Reference images', kind: 'image', max: 10, required: false, primary: true },
      { key: 'reference_video_urls', label: 'Reference videos', kind: 'video', max: 5, required: false },
      { key: 'reference_audio_urls', label: 'Reference audio', kind: 'audio', max: 5, required: false },
      { key: 'start_image', label: 'Start frame', kind: 'image', max: 1, required: false },
    ],
  },
];

const tasks = new Map<string, { at: number; req: CreateRequest }>();

export class MockProvider implements Provider {
  id = 'mock';
  name = 'Mock';
  authType = 'apiKey' as const;
  unit = 'credits';
  async configured() { return true; }
  async listModels(modality: Modality) { return MODELS.filter(m => m.modality === modality); }
  async getModel(model: string) {
    const found = MODELS.find(m => m.model === model);
    if (!found) throw new ProviderError('Unknown mock model.', 404);
    return found;
  }
  async quote(req: CreateRequest) { return { amount: req.settings.quality === 'high' ? 2 : 1, unit: this.unit }; }
  async upload(_file: string, _mime: string, filename: string) { return { uri: `mock://${filename}` }; }
  async create(req: CreateRequest) {
    const taskId = randomUUID();
    tasks.set(taskId, { at: Date.now(), req });
    console.log('[mock] create', JSON.stringify({ prompt: req.prompt, settings: req.settings, refs: req.refs }));
    return { taskId, state: 'queued' as const, estimatedCost: await this.quote(req).then(q => q.amount) };
  }
  async task(taskId: string): Promise<TaskResult> {
    const task = tasks.get(taskId);
    if (!task) return { state: 'failed', error: 'Mock task lost (server restarted).', assets: [] };
    if (Date.now() - task.at < 4000) return { state: 'running', assets: [] };
    if (task.req.settings.fail) return { state: 'failed', error: 'Mock failure requested.', assets: [] };
    const [w, h] = String(task.req.settings.aspect_ratio || '3:4').split(':').map(Number);
    const hue = Math.floor(Math.random() * 360);
    const dir = path.join(os.tmpdir(), 'studio-mock');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${taskId}.png`);
    await sharp({ create: { width: w * 128, height: h * 128, channels: 3, background: `hsl(${hue}, 70%, 55%)` } }).png().toFile(file);
    return { state: 'succeeded', cost: 1, assets: [{ url: `file://${file}`, mime: 'image/png' }] };
  }
  async balance() { return { amount: 999, unit: this.unit, detail: 'mock' }; }
}
