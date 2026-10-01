import { one, q } from '../db.js';
import { openJson, sealJson } from './secrets.js';

export interface ProviderRow {
  provider_id: string;
  /** Decrypted secrets (API keys, OAuth tokens). */
  credentials: Record<string, any>;
  state: Record<string, any>;
  enabled: boolean;
}

/** A user's connection to one provider. Credentials are stored encrypted and decrypted here. */
export async function getProviderRow(userId: string, providerId: string): Promise<ProviderRow> {
  const row = await one<ProviderRow>('select * from provider_settings where user_id = $1 and provider_id = $2', [userId, providerId]);
  if (!row) return { provider_id: providerId, credentials: {}, state: {}, enabled: true };
  return { ...row, credentials: openJson(row.credentials) };
}

async function upsert(userId: string, providerId: string, column: 'credentials' | 'state', value: Record<string, any>) {
  const stored = column === 'credentials' ? sealJson(value) : value;
  await q(
    `insert into provider_settings (user_id, provider_id, ${column}) values ($1, $2, $3)
     on conflict (user_id, provider_id) do update set ${column} = excluded.${column}, updated_at = now()`,
    [userId, providerId, JSON.stringify(stored)],
  );
}

export async function saveCredentials(userId: string, providerId: string, patch: Record<string, any>, replace = false) {
  const current = replace ? {} : (await getProviderRow(userId, providerId)).credentials;
  await upsert(userId, providerId, 'credentials', { ...current, ...patch });
}

export async function saveState(userId: string, providerId: string, patch: Record<string, any>, replace = false) {
  const current = replace ? {} : (await getProviderRow(userId, providerId)).state;
  await upsert(userId, providerId, 'state', JSON.parse(JSON.stringify({ ...current, ...patch })));
}

export async function setEnabled(userId: string, providerId: string, enabled: boolean) {
  await q(
    `insert into provider_settings (user_id, provider_id, enabled) values ($1, $2, $3)
     on conflict (user_id, provider_id) do update set enabled = excluded.enabled, updated_at = now()`,
    [userId, providerId, enabled],
  );
}

/** Encrypt credentials still stored as plaintext (rows from before encryption existed). */
export async function encryptLegacyCredentials() {
  const rows = await q<{ user_id: string; provider_id: string; credentials: any }>('select user_id, provider_id, credentials from provider_settings');
  let count = 0;
  for (const row of rows) {
    if (!row.credentials || row.credentials.enc || !Object.keys(row.credentials).length) continue;
    await q('update provider_settings set credentials = $3 where user_id = $1 and provider_id = $2',
      [row.user_id, row.provider_id, JSON.stringify(sealJson(row.credentials))]);
    count++;
  }
  if (count) console.log(`encrypted ${count} stored provider credential(s)`);
}
