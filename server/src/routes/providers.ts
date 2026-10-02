import type { FastifyInstance, FastifyRequest } from 'fastify';
import { q } from '../db.js';
import { higgsfieldFor, providersFor, spicyFor } from '../providers/registry.js';
import { ProviderError, type Modality } from '../providers/types.js';
import { modelFor, quoteGeneration, type GenerateInput } from '../services/generations.js';
import { getProviderRow, saveCredentials, setEnabled } from '../services/providerSettings.js';
import { AUTO, autoModel, families, getRouterSettings, isUncensored, updateRouterSettings } from '../services/router.js';

const origin = (request: FastifyRequest) => `${request.protocol}://${request.headers['x-forwarded-host'] || request.headers.host}`;
const uid = (request: FastifyRequest) => request.userId!;

/** A user's connection status for one provider (secrets never leave the server). */
async function status(userId: string, id: string) {
  const provider = providersFor(userId).find(p => p.id === id)!;
  const row = await getProviderRow(userId, id);
  let detail: string | undefined;
  if (provider.authType === 'apiKey') {
    const key: string = row.credentials.apiKey || '';
    detail = key ? `Key …${key.slice(-4)}` : undefined;
  } else if (row.credentials.connectedAt) {
    detail = `Connected ${new Date(row.credentials.connectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return { id, name: provider.name, authType: provider.authType, unit: provider.unit, configured: await provider.configured(), enabled: row.enabled, detail };
}

/** The Auto models a user picked, for one modality. */
async function autoModels(userId: string, modality: Modality) {
  const { models } = await getRouterSettings(userId);
  if (!models.length) return [];
  const all = await families(userId);
  return models.map(key => all.get(key)).filter(f => f && f.modality === modality).map(f => autoModel(f!));
}

const autoGroup = (models: ReturnType<typeof autoModel>[]) => ({
  id: AUTO, name: 'Auto', authType: 'apiKey', unit: 'USD', configured: true, enabled: true,
  detail: 'Cheapest provider with enough balance', models,
});

const favorites = async (userId: string) =>
  (await q<{ model_id: string }>('select model_id from favorite_models where user_id = $1 order by created_at', [userId])).map(r => r.model_id);

export function providerRoutes(app: FastifyInstance) {
  app.get('/api/providers', async request => Promise.all(providersFor(uid(request)).map(p => status(uid(request), p.id))));

  /** API-key providers (SpicyAPI, PoYo): the key is checked with a balance call before it's kept. */
  const keyProvider = (userId: string, id: string) => {
    const provider = providersFor(userId).find(p => p.id === id);
    if (!provider || provider.authType !== 'apiKey' || !provider.balance) throw new ProviderError('Unknown provider.', 404);
    return provider;
  };

  app.put('/api/providers/:id/key', async request => {
    const userId = uid(request);
    const { id } = request.params as { id: string };
    const provider = keyProvider(userId, id);
    const key = String((request.body as any)?.apiKey || '').trim();
    if (!key) throw new ProviderError(`Paste your ${provider.name} API key.`, 400);
    const previous = (await getProviderRow(userId, id)).credentials;
    await saveCredentials(userId, id, { apiKey: key });
    try { await provider.balance!(); }
    catch (error) { await saveCredentials(userId, id, previous, true); throw error; }
    return status(userId, id);
  });

  app.delete('/api/providers/:id/key', async request => {
    const { id } = request.params as { id: string };
    keyProvider(uid(request), id);
    await saveCredentials(uid(request), id, {}, true);
    return status(uid(request), id);
  });

  app.put('/api/providers/:id/enabled', async request => {
    const { id } = request.params as { id: string };
    if (!providersFor(uid(request)).some(p => p.id === id)) throw new ProviderError('Unknown provider.', 404);
    await setEnabled(uid(request), id, Boolean((request.body as any)?.enabled));
    return status(uid(request), id);
  });

  app.post('/api/providers/higgsfield/connect', async request => {
    const url = await higgsfieldFor(uid(request)).startLogin(`${origin(request)}/api/oauth/higgsfield/callback`);
    return url ? { url } : { connected: true };
  });

  // The browser returns here from Higgsfield's login with the user's session cookie.
  app.get('/api/oauth/higgsfield/callback', async (request, reply) => {
    const { code, state, error, error_description } = request.query as Record<string, string | undefined>;
    try {
      if (error) throw new ProviderError(error_description || error, 400);
      if (!code) throw new ProviderError('Higgsfield did not return a login code.', 400);
      await higgsfieldFor(uid(request)).finishLogin(code, state);
      return reply.redirect('/?settings=providers&connected=higgsfield');
    } catch (e: any) {
      return reply.redirect(`/?settings=providers&error=${encodeURIComponent(e.message || 'Login failed')}`);
    }
  });

  app.post('/api/providers/higgsfield/disconnect', async request => {
    await higgsfieldFor(uid(request)).disconnect();
    return status(uid(request), 'higgsfield');
  });

  app.post('/api/providers/:id/test', async request => {
    const { id } = request.params as { id: string };
    const provider = providersFor(uid(request)).find(p => p.id === id);
    if (!provider) throw new ProviderError('Unknown provider.', 404);
    if (provider.balance) return { ok: true, balance: await provider.balance() };
    await provider.listModels('image');
    return { ok: true };
  });

  app.get('/api/models', async request => {
    const userId = uid(request);
    const { modality } = request.query as { modality?: Modality };
    if (modality !== 'image' && modality !== 'video') throw new ProviderError('Choose image or video.', 400);
    const groups = await Promise.all(providersFor(userId).map(async p => {
      const s = await status(userId, p.id);
      if (!s.configured || !s.enabled) return { ...s, models: [] };
      try { return { ...s, models: await p.listModels(modality) }; }
      catch (error: any) { return { ...s, models: [], error: error.message }; }
    }));
    // The user's Auto models (routed to the cheapest provider) come first.
    const auto = await autoModels(userId, modality);
    return { providers: auto.length ? [autoGroup(auto), ...groups] : groups, favorites: await favorites(userId) };
  });

  // ---------- auto router
  app.get('/api/router', async request => {
    const userId = uid(request);
    const settings = await getRouterSettings(userId);
    const all = [...(await families(userId)).values()];
    // Every routable model, also those only one provider offers (more providers can join later);
    // ones offered by several providers first.
    const providerCount = (f: (typeof all)[number]) => new Set(f.candidates.map(c => c.provider.id)).size;
    return {
      families: all.sort((a, b) => a.modality.localeCompare(b.modality) || providerCount(b) - providerCount(a) || a.name.localeCompare(b.name)).map(f => ({
        key: f.key, name: f.name, modality: f.modality, providers: [...new Set(f.candidates.map(c => c.provider.name))],
        // The concrete models an Auto model can resolve to (uncensored ones first).
        models: f.candidates
          .map(c => ({ provider: c.provider.name, name: c.model.name, uncensored: isUncensored(c.model) }))
          .sort((a, b) => Number(b.uncensored) - Number(a.uncensored) || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)),
      })),
      selected: settings.models,
      // Credit-based providers: what one credit is worth in dollars (to compare prices across providers).
      credits: providersFor(userId).filter(p => p.unit !== 'USD').map(p => ({
        id: p.id, name: p.name, unit: p.unit, value: settings.creditValues[p.id] ?? p.unitValueUsd ?? null, known: p.unitValueUsd !== undefined,
      })),
    };
  });

  app.patch('/api/router', async request => {
    const body = (request.body || {}) as { models?: string[]; creditValues?: Record<string, number> };
    await updateRouterSettings(uid(request), body);
    return { ok: true };
  });

  app.get('/api/model', async request => {
    const { id } = request.query as { id?: string };
    if (String(id).startsWith(`${AUTO}:`)) {
      const model = [...await autoModels(uid(request), 'image'), ...await autoModels(uid(request), 'video')].find(m => m.id === id);
      if (!model) throw new ProviderError('This Auto model is not available.', 404);
      return model;
    }
    return (await modelFor(uid(request), String(id || ''))).model;
  });

  app.put('/api/favorites/models', async request => {
    const userId = uid(request);
    const { modelId, favorite } = (request.body || {}) as { modelId?: string; favorite?: boolean };
    if (!modelId || !modelId.includes(':')) throw new ProviderError('Invalid model.', 400);
    if (favorite) await q('insert into favorite_models (user_id, model_id) values ($1, $2) on conflict do nothing', [userId, modelId]);
    else await q('delete from favorite_models where user_id = $1 and model_id = $2', [userId, modelId]);
    return favorites(userId);
  });

  app.get('/api/balances', async request => {
    const userId = uid(request);
    const results = await Promise.all(providersFor(userId).map(async p => {
      const s = await status(userId, p.id);
      if (!p.balance || !s.configured || !s.enabled) return null;
      try { return { providerId: p.id, name: p.name, ...(await p.balance()) }; }
      catch (error: any) { return { providerId: p.id, name: p.name, amount: null, unit: p.unit, error: error.message }; }
    }));
    return results.filter(Boolean);
  });

  app.post('/api/quote', async request => ({ cost: await quoteGeneration(uid(request), request.body as GenerateInput) }));
}
