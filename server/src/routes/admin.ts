import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createUser, hashPassword, requireAdmin, revokeSessions, validPassword } from '../auth.js';
import { one, q } from '../db.js';
import { dropProviders } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import { collectGarbage } from '../services/media.js';
import { getUserSettings, publicSettings, testTarget, updateUserSettings, normaliseTarget } from '../services/saveTargets.js';

const bad = (message: string, status = 400): never => { throw new ProviderError(message, status); };
const uid = (request: FastifyRequest) => request.userId!;
const USERNAME = /^[A-Za-z0-9._-]{2,40}$/;

async function userDto(id: string) {
  const u = await one(
    `select u.id, u.username, u.role, u.created_at,
            (select count(*) from workspaces w where w.user_id = u.id) as workspaces,
            (select count(*) from assets a join workspaces w on w.id = a.workspace_id where w.user_id = u.id) as results,
            (select max(last_seen) from sessions s where s.user_id = u.id) as last_seen
       from users u where u.id = $1`, [id]);
  return u && { id: u.id, username: u.username, role: u.role, createdAt: u.created_at, workspaces: u.workspaces, results: u.results, lastSeen: u.last_seen };
}

async function adminCount() {
  return (await one<{ n: number }>(`select count(*) as n from users where role = 'admin'`))!.n;
}

export function adminRoutes(app: FastifyInstance) {
  // ---------- the signed-in user's own settings ----------
  // `onboarded`: the first-run setup wizard was finished or skipped (false shows it again).
  const mySettings = async (userId: string) => ({
    ...publicSettings(await getUserSettings(userId)),
    onboarded: Boolean((await one('select onboarded_at from user_settings where user_id = $1', [userId]))?.onboarded_at),
  });
  app.get('/api/me/settings', async request => mySettings(uid(request)));

  app.patch('/api/me/settings', async request => {
    const body = (request.body || {}) as { stripMetadata?: boolean; saveTarget?: unknown; onboarded?: boolean };
    if (typeof body.onboarded === 'boolean') {
      await q(`insert into user_settings (user_id, onboarded_at) values ($1, $2)
               on conflict (user_id) do update set onboarded_at = excluded.onboarded_at`, [uid(request), body.onboarded ? new Date() : null]);
    }
    if (body.stripMetadata !== undefined || body.saveTarget !== undefined) await updateUserSettings(uid(request), body);
    return mySettings(uid(request));
  });

  // Try a save location (the form's values, or the stored one) by writing and removing a probe file.
  app.post('/api/me/settings/save-target/test', async request => {
    const current = (await getUserSettings(uid(request))).saveTarget;
    const body = (request.body || {}) as { saveTarget?: unknown };
    const target = body.saveTarget ? normaliseTarget(body.saveTarget, current) : current;
    if (!target) bad('Choose a save location first.');
    return { ok: true, message: await testTarget(target!) };
  });

  // ---------- user management (admins only) ----------
  app.get('/api/admin/users', async request => {
    requireAdmin(request);
    const ids = await q<{ id: string }>('select id from users order by created_at');
    return Promise.all(ids.map(r => userDto(r.id)));
  });

  app.post('/api/admin/users', async request => {
    requireAdmin(request);
    const { username, password, role } = (request.body || {}) as { username?: string; password?: string; role?: string };
    const name = String(username || '').trim();
    if (!USERNAME.test(name)) bad('Usernames are 2–40 characters: letters, numbers, dot, dash or underscore.');
    if (!validPassword(password)) bad('Passwords need at least 8 characters.');
    if (await one('select 1 from users where lower(username) = lower($1)', [name])) bad('That username is taken.');
    const id = await createUser(name, String(password), role === 'admin' ? 'admin' : 'user');
    return userDto(id);
  });

  app.patch('/api/admin/users/:id', async request => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const target = await one('select * from users where id = $1', [id]);
    if (!target) bad('User not found.', 404);
    const body = (request.body || {}) as { username?: string; role?: string; password?: string };
    if (body.username !== undefined) {
      const name = String(body.username).trim();
      if (!USERNAME.test(name)) bad('Usernames are 2–40 characters: letters, numbers, dot, dash or underscore.');
      if (await one('select 1 from users where lower(username) = lower($1) and id <> $2', [name, id])) bad('That username is taken.');
      await q('update users set username = $2 where id = $1', [id, name]);
    }
    if (body.role !== undefined) {
      const role = body.role === 'admin' ? 'admin' : 'user';
      if (role === 'user' && target.role === 'admin' && (await adminCount()) <= 1) bad('Keep at least one admin.');
      await q('update users set role = $2 where id = $1', [id, role]);
    }
    if (body.password !== undefined) {
      if (!validPassword(body.password)) bad('Passwords need at least 8 characters.');
      await q('update users set password_hash = $2 where id = $1', [id, await hashPassword(String(body.password))]);
      // A reset signs the user out everywhere (except the admin's own current session if they reset themselves).
      await revokeSessions(id, id === uid(request) ? request.sessionHash : undefined);
    }
    return userDto(id);
  });

  app.post('/api/admin/users/:id/delete', async request => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const { confirm } = (request.body || {}) as { confirm?: string };
    const target = await one('select * from users where id = $1', [id]);
    if (!target) bad('User not found.', 404);
    if (id === uid(request)) bad("You can't delete your own account.");
    if (target.role === 'admin' && (await adminCount()) <= 1) bad('Keep at least one admin.');
    if (confirm !== target.username) bad('Type the username to confirm.');
    // Their media files: removed afterwards if nothing else uses them. Files already saved to their
    // save location are never touched.
    const files = (await q<{ file: string }>(
      `select r.file from refs r join workspaces w on w.id = r.workspace_id where w.user_id = $1
       union select a.file from assets a join workspaces w on w.id = a.workspace_id where w.user_id = $1
       union select file from environments where user_id = $1`, [id])).map(r => r.file);
    await q('delete from users where id = $1', [id]); // cascades to sessions, workspaces (and their content), settings
    dropProviders(id);
    collectGarbage(files).catch(error => console.error('garbage collection after user delete', error));
    return { ok: true };
  });
}
