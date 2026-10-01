import { useState } from 'react';
import { api } from '../lib/api';
import { errorText } from '../lib/store';
import { Button, Field, inputClass } from './ui';

export function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(setup ? '/api/auth/setup' : '/api/auth/login', { username, password });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-5 pt-safe">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-3xl border border-line bg-panel p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-10" />
          <div>
            <div className="text-lg font-semibold">Spicy Studio</div>
            <div className="text-sm text-muted">{setup ? 'Create your account to get started' : 'Sign in to continue'}</div>
          </div>
        </div>
        <Field label="Username">
          <input className={inputClass} autoComplete="username" autoCapitalize="none" value={username} onChange={e => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password" hint={setup ? 'At least 8 characters. You stay signed in on this device until you sign out.' : undefined}>
          <input className={inputClass} type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={setup ? 8 : 1} />
        </Field>
        {error && <div className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        <Button variant="primary" size="lg" className="w-full" loading={busy} type="submit">{setup ? 'Create account' : 'Sign in'}</Button>
      </form>
    </div>
  );
}
