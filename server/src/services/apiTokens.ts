import { createHash, randomBytes } from 'node:crypto';
import { one, q } from '../db.js';
import { ProviderError } from '../providers/types.js';

/**
 * API tokens let agents (MCP clients) act as their user. Each token has its own permissions and an
 * optional workspace allowlist; listing and reading are always allowed within its workspaces.
 */
export const PERMS = ['generate', 'folders', 'upload', 'presets', 'save', 'delete'] as const;
export type Perm = (typeof PERMS)[number];

export interface Agent { id: string; userId: string; name: string; perms: Perm[]; workspaceIds: string[] | null }

const PREFIX = 'sst_';
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => `${PREFIX}${randomBytes(32).toString('base64url')}`;

/** The token in an `Authorization: Bearer …` header, if it looks like one of ours. */
export function parseBearer(header: unknown): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || '').trim());
  return match && match[1].startsWith(PREFIX) && match[1].length <= 200 ? match[1] : null;
}

export const cleanPerms = (value: unknown): Perm[] =>
  PERMS.filter(p => Array.isArray(value) && value.includes(p));

const UUID = /^[0-9a-f-]{36}$/;
/** null = every workspace. An empty list is kept as "none" rather than widened to all. */
export const cleanWorkspaces = (value: unknown): string[] | null =>
  Array.isArray(value) ? [...new Set(value.map(String).filter(id => UUID.test(id)))] : null;

export const allowsWorkspace = (agent: Pick<Agent, 'workspaceIds'>, workspaceId: string) =>
  !agent.workspaceIds || agent.workspaceIds.includes(workspaceId);

export function requirePerm(agent: Pick<Agent, 'perms' | 'name'>, perm: Perm) {
  if (!agent.perms.includes(perm)) {
    throw new ProviderError(`This agent key isn't allowed to ${PERM_TEXT[perm]}. Turn on "${perm}" for "${agent.name}" in Settings → Agents.`, 403);
  }
}

const PERM_TEXT: Record<Perm, string> = {
  generate: 'generate (or price) images and videos',
  folders: 'create folders or move results',
  upload: 'upload references',
  presets: 'use presets',
  save: 'save results to the save location',
  delete: 'delete results',
};

const dto = (r: any) => ({
  id: r.id, name: r.name, last4: r.last4, perms: r.perms, workspaceIds: r.workspace_ids,
  createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

const cleanName = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60);

export async function listTokens(userId: string) {
  return (await q('select * from api_tokens where user_id = $1 order by created_at', [userId])).map(dto);
}

/** Create a token. The token itself is returned only here; afterwards only its last 4 characters are known. */
export async function createToken(userId: string, body: { name?: unknown; perms?: unknown; workspaceIds?: unknown }) {
  const name = cleanName(body.name);
  if (!name) throw new ProviderError('Name the agent, e.g. "Mia poster".', 400);
  const token = newToken();
  const row = await one(
    `insert into api_tokens (user_id, name, token_hash, last4, perms, workspace_ids) values ($1,$2,$3,$4,$5,$6) returning *`,
    [userId, name, hashToken(token), token.slice(-4), cleanPerms(body.perms), await ownWorkspaceIds(userId, body.workspaceIds)]);
  return { token, agent: dto(row) };
}

export async function updateToken(userId: string, id: string, body: { name?: unknown; perms?: unknown; workspaceIds?: unknown }) {
  const current = await one('select * from api_tokens where id = $1 and user_id = $2', [id, userId]);
  if (!current) throw new ProviderError('Not found.', 404);
  const row = await one(
    'update api_tokens set name = $2, perms = $3, workspace_ids = $4 where id = $1 returning *',
    [id, body.name !== undefined ? cleanName(body.name) || current.name : current.name,
      body.perms !== undefined ? cleanPerms(body.perms) : current.perms,
      body.workspaceIds !== undefined ? await ownWorkspaceIds(userId, body.workspaceIds) : current.workspace_ids]);
  return dto(row);
}

export async function deleteToken(userId: string, id: string) {
  await q('delete from api_tokens where id = $1 and user_id = $2', [id, userId]);
}

/** Keep only the user's own workspaces in an allowlist. */
async function ownWorkspaceIds(userId: string, value: unknown) {
  const ids = cleanWorkspaces(value);
  if (!ids) return null;
  if (!ids.length) return [];
  return (await q<{ id: string }>('select id from workspaces where user_id = $1 and id = any($2::uuid[])', [userId, ids])).map(r => r.id);
}

/** The agent for a bearer token, or null. Last use is recorded at most once a minute. */
export async function agentForToken(token: string): Promise<Agent | null> {
  const hash = hashToken(token);
  const row = await one('select * from api_tokens where token_hash = $1', [hash]);
  if (!row) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    q('update api_tokens set last_used_at = now() where id = $1', [row.id]).catch(() => {});
  }
  return { id: row.id, userId: row.user_id, name: row.name, perms: cleanPerms(row.perms), workspaceIds: row.workspace_ids };
}
