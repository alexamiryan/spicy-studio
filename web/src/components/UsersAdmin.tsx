import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { KeyRound, Pencil, Plus, Shield, Trash2, User } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { queryClient, useAuth } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import type { AdminUser } from '../lib/types';
import { Button, Field, Modal, Segmented, Spinner, inputClass } from './ui';

const refresh = () => queryClient.invalidateQueries({ queryKey: ['adminUsers'] });

function UserForm({ user, onDone }: { user: AdminUser | null; onDone: () => void }) {
  const toast = useStore(s => s.toast);
  const [username, setUsername] = useState(user?.username || '');
  const [role, setRole] = useState<'admin' | 'user'>(user?.role || 'user');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (user) {
        const patch: Record<string, string> = {};
        if (username !== user.username) patch.username = username;
        if (role !== user.role) patch.role = role;
        if (password) patch.password = password;
        await api.patch(`/api/admin/users/${user.id}`, patch);
        toast(password ? `Saved. ${username} was signed out everywhere.` : 'Saved', 'ok');
      } else {
        await api.post('/api/admin/users', { username, password, role });
        toast(`Created ${username}`, 'ok');
      }
      refresh();
      onDone();
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className="space-y-4 p-5">
      <Field label="Username" hint="Letters, numbers, dot, dash or underscore.">
        <input className={inputClass} value={username} onChange={e => setUsername(e.target.value.trim())} autoCapitalize="none" autoComplete="off" required />
      </Field>
      <Field label="Role">
        <Segmented value={role} onChange={setRole} options={[{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }]} />
      </Field>
      <Field label={user ? 'Reset password' : 'Password'} hint={user ? 'Leave empty to keep the current password. A reset signs the user out on all devices.' : 'At least 8 characters. They can change it in Settings → Account.'}>
        <input className={inputClass} type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}
          minLength={user ? undefined : 8} required={!user} placeholder={user ? 'Unchanged' : ''} />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!username || (!user && password.length < 8) || (Boolean(password) && password.length < 8)}>
          {user ? 'Save' : 'Create user'}
        </Button>
      </div>
    </form>
  );
}

function DeleteUser({ user, onDone }: { user: AdminUser; onDone: () => void }) {
  const toast = useStore(s => s.toast);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await api.post(`/api/admin/users/${user.id}/delete`, { confirm });
      toast(`Deleted ${user.username}`, 'ok');
      refresh();
      onDone();
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(false); }
  }
  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-muted">
        This permanently deletes <span className="font-semibold text-fg">{user.username}</span> with {user.workspaces} workspace{user.workspaces === 1 ? '' : 's'},{' '}
        {user.results} result{user.results === 1 ? '' : 's'}, their references and settings. Files they already saved to their save location are not touched.
      </p>
      <Field label={`Type ${user.username} to confirm`}>
        <input className={inputClass} value={confirm} onChange={e => setConfirm(e.target.value)} autoCapitalize="none" autoComplete="off" />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button variant="danger" loading={busy} disabled={confirm !== user.username} onClick={remove}><Trash2 className="size-4" />Delete user</Button>
      </div>
    </div>
  );
}

/** Settings → Users (admins only): create, edit and delete accounts. */
export function UsersAdmin() {
  const { data: me } = useAuth();
  const { data: users, isLoading } = useQuery({ queryKey: ['adminUsers'], queryFn: () => api.get<AdminUser[]>('/api/admin/users') });
  const [editing, setEditing] = useState<AdminUser | null | 'new'>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);

  return (
    <div className="space-y-3 p-4">
      <Button variant="outline" className="w-full" onClick={() => setEditing('new')}><Plus className="size-4" />New user</Button>
      {isLoading ? <div className="flex justify-center py-8"><Spinner /></div> : users?.map(u => (
        <div key={u.id} className="flex items-center gap-3 rounded-2xl border border-line p-3">
          <span className={clsx('flex size-10 shrink-0 items-center justify-center rounded-xl', u.role === 'admin' ? 'bg-accent/15 text-accent' : 'bg-panel-3 text-muted')}>
            {u.role === 'admin' ? <Shield className="size-5" /> : <User className="size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 truncate font-medium">
              {u.username}
              {u.id === me?.userId && <span className="text-xs font-normal text-accent">you</span>}
              {u.role === 'admin' && <span className="rounded-md bg-accent/10 px-1.5 text-[11px] font-normal text-accent">admin</span>}
            </div>
            <div className="truncate text-xs text-faint">
              {u.workspaces} workspace{u.workspaces === 1 ? '' : 's'} · {u.results} results · {u.lastSeen ? `active ${new Date(u.lastSeen).toLocaleDateString()}` : 'never signed in'}
            </div>
          </div>
          <button aria-label={`Edit ${u.username}`} title="Edit / reset password" onClick={() => setEditing(u)} className="flex size-10 items-center justify-center rounded-xl text-muted hover:bg-white/8 hover:text-fg">
            {u.id === me?.userId ? <Pencil className="size-4" /> : <KeyRound className="size-4" />}
          </button>
          {u.id !== me?.userId && (
            <button aria-label={`Delete ${u.username}`} title="Delete user" onClick={() => setDeleting(u)} className="flex size-10 items-center justify-center rounded-xl text-danger hover:bg-danger/10">
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      ))}
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'New user' : `Edit ${editing?.username ?? ''}`}>
        {editing !== null && <UserForm user={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Modal>
      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="Delete user">
        {deleting && <DeleteUser user={deleting} onDone={() => setDeleting(null)} />}
      </Modal>
    </div>
  );
}
