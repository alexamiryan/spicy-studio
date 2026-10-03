import { one, q } from '../db.js';
import { ProviderError } from '../providers/types.js';
import { ownedIds, ownRow } from './access.js';
import { collectGarbage } from './media.js';
import { saveForUser } from './saveTargets.js';

// Actions on results shared by the web routes and the agent (MCP) tools. Ids are checked for ownership.

const bad = (message: string, status = 400): never => { throw new ProviderError(message, status); };

/** "Save": copy a result to the user's save location (server folder or SMB share). Returns where it went. */
export async function saveAsset(userId: string, id: string) {
  await ownRow(userId, 'assets', id);
  const a = await one(
    `select a.*, g.model_name, w.image_export_dir, w.video_export_dir
       from assets a join generations g on g.id = a.generation_id join workspaces w on w.id = a.workspace_id where a.id = $1`, [id]);
  const result = await saveForUser(userId, {
    file: a.file, mime: a.mime, relDir: a.kind === 'video' ? a.video_export_dir : a.image_export_dir,
    createdAt: new Date(a.created_at), modelName: a.model_name, index: a.idx,
  });
  await q(`update assets set exported_paths = exported_paths || $2::jsonb where id = $1`, [id, JSON.stringify([result.entry])]);
  return result.display;
}

/** Move results into a folder (null = Unsorted), within their workspace. */
export async function moveAssets(userId: string, assetIds: string[], folderId: string | null) {
  const ids = await ownedIds(userId, 'assets', assetIds);
  if (!ids.length) bad('Select something to move.');
  if (folderId) {
    const folder = await ownRow(userId, 'folders', folderId);
    const others = await one('select 1 from assets where id = any($1::uuid[]) and workspace_id <> $2 limit 1', [ids, folder.workspace_id]);
    if (others) bad('Items can only move within their workspace.');
  }
  return (await q('update assets set folder_id = $2 where id = any($1::uuid[]) returning id', [ids, folderId])).length;
}

/** Delete results (and generations left without any), then their files if nothing else uses them. */
export async function deleteAssets(userId: string, assetIds: string[]) {
  const ids = await ownedIds(userId, 'assets', assetIds);
  if (!ids.length) bad('Select something to delete.');
  const removed = await q<{ file: string; generation_id: string }>('delete from assets where id = any($1::uuid[]) returning file, generation_id', [ids]);
  await q(
    `delete from generations g where g.id = any($1::uuid[]) and g.status = 'succeeded'
       and not exists (select 1 from assets a where a.generation_id = g.id)`, [removed.map(r => r.generation_id)]);
  collectGarbage(removed.map(r => r.file)).catch(() => {});
  return removed.length;
}

/** A folder by name in a workspace, created if missing (names are unique per workspace, ignoring case). */
export async function folderByName(workspaceId: string, name: string) {
  const existing = await one('select * from folders where workspace_id = $1 and lower(name) = lower($2)', [workspaceId, name]);
  if (existing) return { id: existing.id as string, name: existing.name as string };
  const row = await one('insert into folders (workspace_id, name) values ($1, $2) returning *', [workspaceId, name]);
  return { id: row.id as string, name: row.name as string };
}
