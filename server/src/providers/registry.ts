import { HiggsfieldProvider } from './higgsfield.js';
import { MockProvider } from './mock.js';
import { SpicyProvider } from './spicyapi.js';
import { ProviderError, type Provider } from './types.js';

/**
 * Providers are per user: each user has their own SpicyAPI key and Higgsfield login (and their own
 * MCP connection / catalog cache). Register new providers in `create`; the rest of the app only
 * talks to the Provider interface.
 */
const cache = new Map<string, Provider[]>();

function create(userId: string): Provider[] {
  return [
    new SpicyProvider(userId),
    new HiggsfieldProvider(userId),
    ...(process.env.MOCK_PROVIDER === '1' ? [new MockProvider()] : []),
  ];
}

export function providersFor(userId: string): Provider[] {
  let list = cache.get(userId);
  if (!list) { list = create(userId); cache.set(userId, list); }
  return list;
}

export function getProvider(userId: string, id: string): Provider {
  const provider = providersFor(userId).find(p => p.id === id);
  if (!provider) throw new ProviderError(`Unknown provider ${id}.`, 400);
  return provider;
}

export function higgsfieldFor(userId: string) { return getProvider(userId, 'higgsfield') as HiggsfieldProvider; }
export function spicyFor(userId: string) { return getProvider(userId, 'spicyapi') as SpicyProvider; }

/** Forget a user's provider instances (after deleting the user). */
export function dropProviders(userId: string) { cache.delete(userId); }

export function splitModelId(id: string): { providerId: string; model: string } {
  const at = id.indexOf(':');
  if (at <= 0) throw new ProviderError('Invalid model id.', 400);
  return { providerId: id.slice(0, at), model: id.slice(at + 1) };
}
