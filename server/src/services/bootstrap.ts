import { one, q } from '../db.js';
import { encryptLegacyCredentials, getProviderRow, saveCredentials } from './providerSettings.js';
import { getUserSettings, parseShare, updateUserSettings } from './saveTargets.js';

/**
 * Upgrade steps that need code (not just SQL), run on every start and safe to repeat:
 * - encrypt provider credentials still stored as plaintext;
 * - make sure every user has a settings row;
 * - once only: move SPICY_API_KEY and NAS_* from .env into the first admin's settings.
 */
export async function bootstrap() {
  await encryptLegacyCredentials();
  await q('insert into user_settings (user_id) select id from users on conflict do nothing');
  await importEnvOnce();
}

async function importEnvOnce() {
  if (await one(`select 1 from app_state where key = 'env_imported'`)) return;
  const admin = await one<{ id: string; username: string }>(`select id, username from users where role = 'admin' order by created_at limit 1`);
  if (!admin) return; // fresh install: nothing to import yet
  const imported: string[] = [];

  const key = process.env.SPICY_API_KEY?.trim();
  if (key && !(await getProviderRow(admin.id, 'spicyapi')).credentials.apiKey) {
    await saveCredentials(admin.id, 'spicyapi', { apiKey: key });
    imported.push('SpicyAPI key');
  }

  const share = process.env.NAS_SHARE ? parseShare(process.env.NAS_SHARE) : null;
  if (share && !(await getUserSettings(admin.id)).saveTarget) {
    const updated = await updateUserSettings(admin.id, {
      saveTarget: { type: 'smb', ...share, username: process.env.NAS_USERNAME || '', password: process.env.NAS_PASSWORD || '' },
    });
    imported.push(`SMB save location ${updated.saveLabel}`);
  }

  await q(`insert into app_state (key, value) values ('env_imported', $1) on conflict (key) do nothing`,
    [JSON.stringify({ at: new Date().toISOString(), user: admin.username, imported })]);
  if (imported.length) console.log(`imported from .env into ${admin.username}'s settings: ${imported.join(', ')}`);
}
