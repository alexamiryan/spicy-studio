import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { ProviderError } from '../providers/types.js';
import { resolveInside, sanitizeRelativeDir, saveLocal, savedName, writeSaved } from './exports.js';
import { decrypt, encrypt, isEncrypted } from './secrets.js';

const run = promisify(execFile);

/** Where "Save" writes a user's results. Workspace save folders are relative to this. */
export type SaveTarget =
  | { type: 'local'; path: string }
  | { type: 'smb'; host: string; share: string; path: string; username: string; password: string; domain?: string };

export interface UserSettings { stripMetadata: boolean; saveTarget: SaveTarget | null }

// ---------------------------------------------------------------- settings storage

export async function getUserSettings(userId: string): Promise<UserSettings> {
  const row = await one<{ strip_metadata: boolean; save_target: any }>('select * from user_settings where user_id = $1', [userId]);
  const stored = row?.save_target;
  let saveTarget: SaveTarget | null = null;
  if (stored?.type === 'local') saveTarget = { type: 'local', path: stored.path || '' };
  if (stored?.type === 'smb') {
    saveTarget = {
      type: 'smb', host: stored.host, share: stored.share, path: stored.path || '', username: stored.username || '',
      domain: stored.domain || undefined, password: isEncrypted(stored.password) ? decrypt(stored.password) : (stored.password || ''),
    };
  }
  return { stripMetadata: Boolean(row?.strip_metadata), saveTarget };
}

async function writeSettings(userId: string, stripMetadata: boolean, target: SaveTarget | null) {
  const stored = target?.type === 'smb' ? { ...target, password: target.password ? encrypt(target.password) : '' } : target;
  await q(
    `insert into user_settings (user_id, strip_metadata, save_target, updated_at) values ($1, $2, $3, now())
     on conflict (user_id) do update set strip_metadata = excluded.strip_metadata, save_target = excluded.save_target, updated_at = now()`,
    [userId, stripMetadata, stored ? JSON.stringify(stored) : null]);
}

/** Validate and normalise a save target from the settings form. An empty password keeps the stored one. */
export function normaliseTarget(input: any, previous: SaveTarget | null): SaveTarget | null {
  if (!input || !input.type || input.type === 'none') return null;
  const rel = (value: unknown) => {
    const text = String(value ?? '').trim();
    return text ? sanitizeRelativeDir(text) : '';
  };
  if (input.type === 'local') return { type: 'local', path: rel(input.path) };
  if (input.type !== 'smb') throw new ProviderError('Choose a save location type.', 400);
  const host = String(input.host ?? '').trim().replace(/^\\\\|^\/\//, '').replace(/[\\/].*$/, '');
  const share = String(input.share ?? '').trim().replace(/^[\\/]+|[\\/]+$/g, '');
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new ProviderError('Enter the NAS / server address, e.g. 192.168.1.10.', 400);
  if (!share || /[\\/"]/.test(share)) throw new ProviderError('Enter the share name, e.g. ai.', 400);
  const keepPassword = previous?.type === 'smb' && previous.host === host && previous.share === share;
  const password = String(input.password ?? '') || (keepPassword ? previous.password : '');
  return {
    type: 'smb', host, share, path: rel(input.path), username: String(input.username ?? '').trim(),
    domain: String(input.domain ?? '').trim() || undefined, password,
  };
}

export async function updateUserSettings(userId: string, patch: { stripMetadata?: boolean; saveTarget?: unknown }) {
  const current = await getUserSettings(userId);
  const strip = typeof patch.stripMetadata === 'boolean' ? patch.stripMetadata : current.stripMetadata;
  const target = patch.saveTarget !== undefined ? normaliseTarget(patch.saveTarget, current.saveTarget) : current.saveTarget;
  await writeSettings(userId, strip, target);
  return publicSettings(await getUserSettings(userId));
}

export function targetLabel(target: SaveTarget | null): string {
  if (!target) return '';
  if (target.type === 'local') return [config.exportRootLabel.replace(/[\\/]+$/, ''), target.path].filter(Boolean).join('/');
  return `\\\\${target.host}\\${target.share}${target.path ? `\\${target.path.replace(/\//g, '\\')}` : ''}`;
}

/** Settings as sent to the browser: the SMB password is never returned. */
export function publicSettings(settings: UserSettings) {
  const t = settings.saveTarget;
  return {
    stripMetadata: settings.stripMetadata,
    saveTarget: t?.type === 'smb'
      ? { type: 'smb', host: t.host, share: t.share, path: t.path, username: t.username, domain: t.domain || '', hasPassword: Boolean(t.password) }
      : t,
    saveLabel: targetLabel(t),
    exportRoot: config.exportRootLabel,
  };
}

// ---------------------------------------------------------------- SMB via smbclient

/** Turn smbclient's NT_STATUS codes into something readable. */
export function smbError(output: string): string {
  const code = /NT_STATUS_[A-Z_]+/.exec(output)?.[0];
  const map: Record<string, string> = {
    NT_STATUS_LOGON_FAILURE: 'SMB login failed: check the username and password.',
    NT_STATUS_ACCESS_DENIED: 'The SMB share refused access: this user may not write there.',
    NT_STATUS_BAD_NETWORK_NAME: 'That share name was not found on the server.',
    NT_STATUS_HOST_UNREACHABLE: 'Could not reach the SMB server.',
    NT_STATUS_IO_TIMEOUT: 'The SMB server did not respond (timeout).',
    NT_STATUS_CONNECTION_REFUSED: 'The SMB server refused the connection.',
    NT_STATUS_OBJECT_PATH_NOT_FOUND: 'A folder in the save path does not exist on the share.',
    NT_STATUS_DISK_FULL: 'The SMB share is full.',
  };
  if (code && map[code]) return map[code];
  if (/Connection to .* failed|Name or service not known|No route to host/i.test(output)) return 'Could not reach the SMB server.';
  return `SMB error: ${(code || output.trim().split('\n').pop() || 'unknown').slice(0, 200)}`;
}

const quote = (value: string) => `"${value.replace(/"/g, '')}"`;
const winPath = (...parts: string[]) => parts.filter(Boolean).join('/').split('/').filter(Boolean).join('\\');

/** Run smbclient commands against the target's share. Credentials go through a temporary auth file. */
async function smb(target: Extract<SaveTarget, { type: 'smb' }>, commands: string[], allow: RegExp[] = []): Promise<string> {
  const auth = path.join(os.tmpdir(), `smb-${randomUUID()}.auth`);
  await writeFile(auth, `username = ${target.username || 'guest'}\npassword = ${target.password}\n${target.domain ? `domain = ${target.domain}\n` : ''}`, { mode: 0o600 });
  try {
    const { stdout, stderr } = await run('smbclient', [`//${target.host}/${target.share}`, '-A', auth, '-m', 'SMB3', '-c', commands.join('; ')],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    const output = `${stdout}\n${stderr}`;
    const status = /NT_STATUS_[A-Z_]+/.exec(output)?.[0];
    if (status && !allow.some(re => re.test(status))) throw new ProviderError(smbError(output), 502);
    return output;
  } catch (error: any) {
    if (error instanceof ProviderError) throw error;
    if (error.code === 'ENOENT') throw new ProviderError('smbclient is not installed on the server.', 500);
    const output = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
    const status = /NT_STATUS_[A-Z_]+/.exec(output)?.[0];
    if (status && allow.some(re => re.test(status))) return output;
    throw new ProviderError(smbError(output), 502);
  } finally {
    await rm(auth, { force: true });
  }
}

/** Make sure a folder (and its parents) exists on the share. */
async function smbEnsureDir(target: Extract<SaveTarget, { type: 'smb' }>, dir: string) {
  const parts = dir.split('\\').filter(Boolean);
  if (!parts.length) return;
  const exists = await smb(target, [`cd ${quote(dir)}`], [/OBJECT_(NAME|PATH)_NOT_FOUND/, /NO_SUCH_FILE/, /NOT_A_DIRECTORY/]);
  if (!/NT_STATUS_/.test(exists)) return;
  for (let i = 1; i <= parts.length; i++) {
    await smb(target, [`mkdir ${quote(parts.slice(0, i).join('\\'))}`], [/OBJECT_NAME_COLLISION/]);
  }
}

async function smbAvailableName(target: Extract<SaveTarget, { type: 'smb' }>, dir: string, name: string) {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  const listing = await smb(target, [`ls ${quote(`${dir}\\${base}*`)}`], [/NO_SUCH_FILE/, /OBJECT_NAME_NOT_FOUND/]);
  const taken = new Set([...listing.matchAll(/^\s+(\S.*?)\s+[ADHNRS]*\s+\d+\s+\w{3} /gm)].map(m => m[1].trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${base}-${n}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// ---------------------------------------------------------------- saving

/** Save one result to the user's save location. Returns the stored relative path and a label to show. */
/** Where a saved copy went, recorded on the asset so it can be removed again ("unsave"). */
export type SavedEntry =
  | string // older records: a path relative to the export root (local) or to the SMB target's folder
  | { type: 'local'; relative: string; display: string }
  | { type: 'smb'; host: string; share: string; path: string; display: string };

export async function saveForUser(userId: string, opts: { file: string; mime: string; relDir: string; createdAt: Date; modelName: string; index: number }): Promise<{ entry: SavedEntry; display: string }> {
  const { stripMetadata, saveTarget } = await getUserSettings(userId);
  if (!saveTarget) throw new ProviderError('Choose a save location first: Settings → Save location.', 400);
  if (saveTarget.type === 'local') {
    const saved = await saveLocal({ ...opts, base: saveTarget.path, stripMetadata });
    return { entry: { type: 'local', relative: saved.relative, display: saved.display }, display: saved.display };
  }

  const rel = sanitizeRelativeDir(opts.relDir);
  const dir = winPath(saveTarget.path, rel);
  const temp = path.join(os.tmpdir(), `save-${randomUUID()}${path.extname(opts.file)}`);
  try {
    await writeSaved(opts.file, opts.mime, temp, stripMetadata);
    await smbEnsureDir(saveTarget, dir);
    const name = await smbAvailableName(saveTarget, dir, savedName(opts.createdAt, opts.modelName, opts.index, path.extname(opts.file)));
    await smb(saveTarget, [`put ${quote(temp)} ${quote(`${dir}\\${name}`)}`]);
    const display = `${targetLabel(saveTarget)}\\${rel.replace(/\//g, '\\')}\\${name}`;
    return { entry: { type: 'smb', host: saveTarget.host, share: saveTarget.share, path: `${dir}\\${name}`, display }, display };
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Remove a copy made by Save. A file that is already gone counts as removed. Copies on an SMB share
 * other than the current save location can't be reached (no stored credentials for it).
 */
export async function deleteSaved(userId: string, entry: SavedEntry): Promise<void> {
  const { saveTarget } = await getUserSettings(userId);
  if (typeof entry === 'object' && entry.type === 'local') {
    await rm(resolveInside(config.exportRoot, entry.relative), { force: true });
    return;
  }
  if (typeof entry === 'object' && entry.type === 'smb') {
    if (saveTarget?.type !== 'smb' || saveTarget.host.toLowerCase() !== entry.host.toLowerCase() || saveTarget.share.toLowerCase() !== entry.share.toLowerCase()) {
      throw new ProviderError(`The copy is on \\\\${entry.host}\\${entry.share}, which is not your save location any more. Delete it there by hand.`, 400);
    }
    await smb(saveTarget, [`del ${quote(entry.path)}`], [/NO_SUCH_FILE/, /OBJECT_NAME_NOT_FOUND/, /OBJECT_PATH_NOT_FOUND/]);
    return;
  }
  // Older string records: relative to the current location of the same kind.
  if (!saveTarget) throw new ProviderError('Choose a save location first: Settings → Save location.', 400);
  if (saveTarget.type === 'local') await rm(resolveInside(config.exportRoot, entry), { force: true });
  else await smb(saveTarget, [`del ${quote(winPath(saveTarget.path, entry))}`], [/NO_SUCH_FILE/, /OBJECT_NAME_NOT_FOUND/, /OBJECT_PATH_NOT_FOUND/]);
}

/** Check a save location works by writing and removing a small probe file. */
export async function testTarget(target: SaveTarget): Promise<string> {
  if (target.type === 'local') {
    const base = target.path ? sanitizeRelativeDir(target.path) : '';
    const dir = base ? path.join(config.exportRoot, base) : config.exportRoot;
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `.spicy-studio-test-${randomUUID().slice(0, 8)}`);
    await writeFile(file, 'Spicy Studio write test');
    await rm(file, { force: true });
    return `Saved and removed a test file in ${targetLabel(target)}`;
  }
  const dir = winPath(target.path);
  if (dir) await smbEnsureDir(target, dir);
  const temp = path.join(os.tmpdir(), `probe-${randomUUID()}.txt`);
  const remote = `${dir ? `${dir}\\` : ''}.spicy-studio-test-${randomUUID().slice(0, 8)}.txt`;
  await writeFile(temp, 'Spicy Studio write test');
  try {
    await smb(target, [`put ${quote(temp)} ${quote(remote)}`, `del ${quote(remote)}`]);
  } finally {
    await rm(temp, { force: true });
  }
  return `Saved and removed a test file in ${targetLabel(target)}`;
}

/** Parse a UNC-style share like //192.168.1.10/ai/Pictures into host, share and path. Exported for tests. */
export function parseShare(value: string): { host: string; share: string; path: string } | null {
  const parts = value.trim().replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { host: parts[0], share: parts[1], path: parts.slice(2).join('/') };
}
