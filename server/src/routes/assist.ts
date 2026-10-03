import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assistModels, assistSettings, deleteAssistKey, enhancePrompt, saveAssistKey, updateAssistSettings, type EnhanceInput } from '../services/promptAssist.js';
import { modelInfo } from './providers.js';

const uid = (request: FastifyRequest) => request.userId!;

/** Prompt assistant (OpenRouter): settings, key, model list and the rewrite itself. */
export function assistRoutes(app: FastifyInstance) {
  app.get('/api/assist', async request => assistSettings(uid(request)));
  app.patch('/api/assist', async request => updateAssistSettings(uid(request), (request.body || {}) as any));
  app.put('/api/assist/key', async request => saveAssistKey(uid(request), String((request.body as any)?.apiKey || '')));
  app.delete('/api/assist/key', async request => { await deleteAssistKey(uid(request)); return assistSettings(uid(request)); });
  app.get('/api/assist/models', async () => assistModels());
  app.post('/api/assist/enhance', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const body = (request.body || {}) as EnhanceInput & { modelId?: string };
    return enhancePrompt(uid(request), await modelInfo(uid(request), String(body.modelId || '')), body);
  });
}
