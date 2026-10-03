import { clsx } from 'clsx';
import { Bot, CheckCircle2, ExternalLink, Sparkles, ChevronLeft, HardDrive, KeyRound, Link2, Monitor, Plug, ShieldCheck, SlidersHorizontal, Unplug, UserRound, Users, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { formatBalance } from '../lib/models';
import { keys, queryClient, useAuth, useMySettings, useProviders, useSessions } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import type { Balance, MySettings, ProviderStatus, SaveTargetForm } from '../lib/types';
import { UsersAdmin } from './UsersAdmin';
import { AutoRouterSettings } from './AutoRouterSettings';
import { AgentsSettings } from './AgentsSettings';
import { PromptAssistSettings } from './PromptAssistSettings';
import { Button, Field, IconButton, Segmented, inputClass } from './ui';

function refreshProviders() {
  queryClient.invalidateQueries({ queryKey: keys.providers });
  queryClient.invalidateQueries({ queryKey: keys.balances });
  queryClient.invalidateQueries({ queryKey: ['models'] });
}

/** Where to get each API key, shown under the key field. */
const KEY_HINTS: Record<string, { placeholder: string; help?: React.ReactNode }> = {
  spicyapi: { placeholder: 'Paste API key (sk-spicy-…)' },
  poyo: {
    placeholder: 'Paste your PoYo API key',
    help: <>Generations are paid with your PoYo credits.</>,
  },
};

/** Where to sign up, get a key and add credits, in that order, for people setting a provider up for the first time. */
const PROVIDER_LINKS: Record<string, { label: string; href: string }[]> = {
  spicyapi: [
    { label: 'Create account', href: 'https://spicyapi.ai/register' },
    { label: 'Get API key', href: 'https://spicyapi.ai/console/keys' },
    { label: 'Add credits', href: 'https://spicyapi.ai/pricing' },
  ],
  higgsfield: [
    { label: 'Create account', href: 'https://higgsfield.ai' },
    { label: 'Plans & credits', href: 'https://higgsfield.ai/pricing' },
  ],
  poyo: [
    { label: 'Create account & get API key', href: 'https://poyo.ai/dashboard/api-key' },
    { label: 'Buy credits', href: 'https://poyo.ai/pricing' },
  ],
};

export function SetupLinks({ links }: { links?: { label: string; href: string }[] }) {
  if (!links?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint">
      {links.map((l, i) => (
        <span key={l.href} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>→</span>}
          <a className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline" href={l.href} target="_blank" rel="noreferrer">
            {l.label}<ExternalLink className="size-3" />
          </a>
        </span>
      ))}
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderStatus }) {
  const toast = useStore(s => s.toast);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    try { await fn(); if (done) toast(done); refreshProviders(); }
    catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(null); }
  }

  const test = () => run('test', async () => {
    const r = await api.post<{ balance?: Omit<Balance, 'providerId' | 'name'> }>(`/api/providers/${p.id}/test`);
    toast(r.balance ? `Connected · balance ${formatBalance(r.balance.amount, r.balance.unit)}` : 'Connected');
  });

  return (
    <div className="space-y-3 rounded-2xl border border-line p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-semibold">
            {p.name}
            {p.configured && <CheckCircle2 className="size-4 text-accent" />}
          </div>
          <div className="text-xs text-muted">{p.configured ? p.detail || 'Connected' : 'Not connected'}</div>
        </div>
        <button
          onClick={() => run('toggle', () => api.put(`/api/providers/${p.id}/enabled`, { enabled: !p.enabled }))}
          className={clsx('flex h-7 w-12 items-center rounded-full p-0.5 transition', p.enabled ? 'bg-accent' : 'bg-white/15')}
          aria-label={p.enabled ? 'Disable provider' : 'Enable provider'}
        >
          <span className={clsx('size-6 rounded-full bg-white shadow transition', p.enabled && 'translate-x-5')} />
        </button>
      </div>

      {p.authType === 'apiKey' ? (
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); run('save', () => api.put(`/api/providers/${p.id}/key`, { apiKey: key }), 'API key saved').then(() => setKey('')); }}>
          <div className="relative flex-1">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input className={clsx(inputClass, 'pl-9')} type="password" autoComplete="off" placeholder={p.configured ? 'Replace API key…' : KEY_HINTS[p.id]?.placeholder || 'Paste API key'} value={key} onChange={e => setKey(e.target.value)} />
          </div>
          <Button type="submit" variant="primary" disabled={!key.trim()} loading={busy === 'save'}>Save</Button>
        </form>
      ) : (
        <p className="text-sm text-muted">
          Signs in with your Higgsfield account over MCP and spends your subscription credits (never unlimited generations). The login stays active until you disconnect.
        </p>
      )}
      {p.authType === 'apiKey' && KEY_HINTS[p.id]?.help && <p className="text-xs text-muted">{KEY_HINTS[p.id]!.help}</p>}
      <SetupLinks links={PROVIDER_LINKS[p.id]} />

      <div className="flex flex-wrap gap-2">
        {p.authType === 'oauth' && (
          <Button variant={p.configured ? 'outline' : 'primary'} loading={busy === 'connect'} onClick={() => run('connect', async () => {
            const r = await api.post<{ url?: string }>(`/api/providers/${p.id}/connect`);
            if (r.url) window.location.href = r.url;
          })}>
            <Link2 className="size-4" /> {p.configured ? 'Reconnect' : `Connect ${p.name}`}
          </Button>
        )}
        {p.configured && <Button variant="outline" loading={busy === 'test'} onClick={test}>Test connection</Button>}
        {p.configured && (
          <Button variant="ghost" loading={busy === 'remove'} onClick={() => confirm(`Disconnect ${p.name}?`) && run('remove',
            () => (p.authType === 'oauth' ? api.post(`/api/providers/${p.id}/disconnect`) : api.del(`/api/providers/${p.id}/key`)), 'Disconnected')}>
            <Unplug className="size-4" /> Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}

function AccountTab() {
  const { data: sessions = [] } = useSessions();
  const toast = useStore(s => s.toast);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  async function revoke(id: string) {
    await api.del(`/api/auth/sessions/${id}`);
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { toast("The new passwords don't match", 'error'); return; }
    try {
      await api.post('/api/auth/password', { current, next });
      toast('Password changed. Other devices were signed out.', 'ok');
      setCurrent(''); setNext(''); setConfirm('');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    }
    catch (error) { toast(errorText(error), 'error'); }
  }
  return (
    <div className="space-y-6 p-4">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Signed-in devices</h3>
        {sessions.map(s => (
          <div key={s.id} className="flex items-center gap-3 rounded-xl border border-line p-3 text-sm">
            <Monitor className="size-5 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate">{s.device}{s.current && <span className="ml-2 text-xs text-accent">This device</span>}</div>
              <div className="text-xs text-faint">Last active {new Date(s.lastSeen).toLocaleDateString()}</div>
            </div>
            {!s.current && <Button size="sm" variant="ghost" onClick={() => revoke(s.id)}>Sign out</Button>}
          </div>
        ))}
      </section>
      <form onSubmit={changePassword} className="space-y-3">
        <h3 className="text-sm font-semibold">Change password</h3>
        <Field label="Current password"><input className={inputClass} type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="At least 8 characters. Your other devices will be signed out."><input className={inputClass} type="password" autoComplete="new-password" minLength={8} value={next} onChange={e => setNext(e.target.value)} /></Field>
        <Field label="Repeat new password"><input className={inputClass} type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></Field>
        <Button type="submit" disabled={!current || next.length < 8 || !confirm}>Change password</Button>
      </form>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={clsx('flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition', on ? 'bg-accent' : 'bg-white/15')}
    >
      <span className={clsx('size-6 rounded-full bg-white shadow transition', on && 'translate-x-5')} />
    </button>
  );
}

async function patchSettings(patch: Partial<{ stripMetadata: boolean; saveTarget: SaveTargetForm | null }>) {
  const updated = await api.patch<MySettings>('/api/me/settings', patch);
  queryClient.setQueryData(['mySettings'], updated);
  return updated;
}

function GeneralTab() {
  const toast = useStore(s => s.toast);
  const { data } = useMySettings();
  async function update(stripMetadata: boolean) {
    queryClient.setQueryData<MySettings>(['mySettings'], d => d && { ...d, stripMetadata });
    try { await patchSettings({ stripMetadata }); }
    catch (error) { toast(errorText(error), 'error'); queryClient.invalidateQueries({ queryKey: ['mySettings'] }); }
  }
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-start gap-3 rounded-2xl border border-line p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Remove metadata when saving</div>
          <p className="mt-1 text-sm text-muted">
            Files written by <span className="text-fg">Save</span> get their EXIF, XMP, IPTC, comments and AI-provenance (C2PA)
            data removed. Images keep their exact pixels and colour profile; videos are rewritten without metadata, not re-encoded.
            Originals in the app and Download are not changed.
          </p>
        </div>
        <Toggle label="Remove metadata when saving" on={Boolean(data?.stripMetadata)} onChange={update} />
      </div>
    </div>
  );
}

/** Where "Save" writes: a folder on the server's mounted disk, or an SMB share (NAS). */
function SaveLocationTab() {
  const toast = useStore(s => s.toast);
  const { data } = useMySettings();
  const stored = data?.saveTarget;
  const [type, setType] = useState<'smb' | 'local'>(stored?.type || 'smb');
  const [form, setForm] = useState({ path: '', host: '', share: '', username: '', password: '', domain: '' });
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Load the stored location into the form once it arrives.
  const [loaded, setLoaded] = useState(false);
  if (data && !loaded) {
    setLoaded(true);
    if (stored?.type === 'smb') setForm({ path: stored.path || '', host: stored.host, share: stored.share, username: stored.username, password: '', domain: stored.domain || '' });
    if (stored?.type === 'local') setForm(f => ({ ...f, path: stored.path || '' }));
    if (stored) setType(stored.type);
  }

  const target = (): SaveTargetForm => type === 'local'
    ? { type: 'local', path: form.path }
    : { type: 'smb', host: form.host, share: form.share, path: form.path, username: form.username, password: form.password, domain: form.domain };
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => { setForm(f => ({ ...f, [key]: e.target.value })); setResult(null); };

  async function test() {
    setBusy('test');
    try { const r = await api.post<{ message: string }>('/api/me/settings/save-target/test', { saveTarget: target() }); setResult({ ok: true, text: r.message }); }
    catch (error) { setResult({ ok: false, text: errorText(error) }); }
    finally { setBusy(null); }
  }
  async function save() {
    setBusy('save');
    try { const r = await patchSettings({ saveTarget: target() }); toast(`Save location: ${r.saveLabel}`, 'ok'); setForm(f => ({ ...f, password: '' })); }
    catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(null); }
  }

  const smbPasswordStored = stored?.type === 'smb' && stored.hasPassword && stored.host === form.host && stored.share === form.share;
  return (
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted">
        Where <span className="text-fg">Save</span> writes your results. Each workspace saves into its own subfolders of this location
        (set in the workspace's settings).
        {data?.saveLabel && <> Current: <span className="break-all text-fg">{data.saveLabel}</span></>}
      </p>
      <Segmented value={type} onChange={v => { setType(v); setResult(null); }} options={[
        { value: 'smb', label: 'SMB share (NAS)' }, { value: 'local', label: 'Server folder' },
      ]} />
      {type === 'smb' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Server" hint="IP or name, e.g. 192.168.1.10"><input className={inputClass} value={form.host} onChange={set('host')} autoCapitalize="none" placeholder="192.168.1.10" /></Field>
          <Field label="Share" hint="The shared folder, e.g. ai"><input className={inputClass} value={form.share} onChange={set('share')} autoCapitalize="none" placeholder="ai" /></Field>
          <Field label="Folder inside the share" hint="Optional, e.g. Pictures"><input className={inputClass} value={form.path} onChange={set('path')} placeholder="Pictures" /></Field>
          <Field label="Domain / workgroup" hint="Usually empty"><input className={inputClass} value={form.domain} onChange={set('domain')} autoCapitalize="none" /></Field>
          <Field label="Username"><input className={inputClass} value={form.username} onChange={set('username')} autoCapitalize="none" autoComplete="off" /></Field>
          <Field label="Password" hint={smbPasswordStored ? 'Stored (encrypted). Leave empty to keep it.' : undefined}>
            <input className={inputClass} type="password" value={form.password} onChange={set('password')} autoComplete="new-password" placeholder={smbPasswordStored ? '••••••••' : ''} />
          </Field>
        </div>
      ) : (
        <Field label="Folder" hint={<>Inside the server's export folder <span className="text-muted">{data?.exportRoot}</span>. Leave empty for its root.</>}>
          <input className={inputClass} value={form.path} onChange={set('path')} placeholder="e.g. mia" />
        </Field>
      )}
      {result && (
        <div className={clsx('rounded-xl px-3 py-2 text-sm', result.ok ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger')}>{result.text}</div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" loading={busy === 'test'} onClick={test} disabled={type === 'smb' && (!form.host || !form.share)}>Test connection</Button>
        <Button variant="primary" loading={busy === 'save'} onClick={save} disabled={type === 'smb' && (!form.host || !form.share)}>Save location</Button>
      </div>
    </div>
  );
}

type SettingsTab = 'general' | 'auto' | 'save' | 'providers' | 'assist' | 'agents' | 'account' | 'users';

const SECTIONS: { id: SettingsTab; label: string; icon: React.ReactNode; description: string; admin?: boolean }[] = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal className="size-4" />, description: 'How saving behaves.' },
  { id: 'auto', label: 'Auto models', icon: <Zap className="size-4" />, description: 'Models that go to the cheapest provider with enough balance.' },
  { id: 'save', label: 'Save location', icon: <HardDrive className="size-4" />, description: 'Where Save puts your files: a NAS share or a server folder.' },
  { id: 'providers', label: 'Providers', icon: <Plug className="size-4" />, description: 'Connect the services that generate your images and videos.' },
  { id: 'assist', label: 'Prompt assistant', icon: <Sparkles className="size-4" />, description: 'Rewrite your prompts into detailed ones for each model (Grok via OpenRouter).' },
  { id: 'agents', label: 'Agents', icon: <Bot className="size-4" />, description: 'Keys for AI agents that generate through the studio over MCP.' },
  { id: 'account', label: 'Account', icon: <UserRound className="size-4" />, description: 'Your password and signed-in devices.' },
  { id: 'users', label: 'Users', icon: <Users className="size-4" />, description: 'Create, edit and remove accounts.', admin: true },
];

/** Settings: a full-screen page with sections (sidebar on desktop, a strip of tabs on phones). */
export function SettingsModal() {
  const { modal, set } = useStore();
  const open = modal?.type === 'settings';
  const { data: providers = [] } = useProviders();
  const { data: auth } = useAuth();
  const sections = SECTIONS.filter(x => !x.admin || auth?.role === 'admin');
  const tab = (open && modal.tab && sections.some(x => x.id === modal.tab) ? modal.tab : 'general') as SettingsTab;
  const section = sections.find(x => x.id === tab)!;
  const close = () => set({ modal: null });
  const go = (id: SettingsTab) => set({ modal: { type: 'settings', tab: id } });

  useEffect(() => {
    if (!open) return;
    // Esc closes the page, unless a dialog on top of it handles it first.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;

  return createPortal(
    <div className="pt-safe fade-in fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-2 md:px-4">
        <IconButton label="Back" onClick={close}><ChevronLeft className="size-5" /></IconButton>
        <h1 className="text-base font-semibold">Settings</h1>
        <div className="ml-auto hidden md:block"><IconButton label="Close settings" onClick={close}><X className="size-5" /></IconButton></div>
      </header>
      {/* Phones: the sections as a scrollable strip */}
      <nav className="no-scrollbar flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-3 py-2 md:hidden">
        {sections.map(x => (
          <button key={x.id} onClick={() => go(x.id)}
            className={clsx('flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm', x.id === tab ? 'bg-white/10 font-medium text-fg' : 'text-muted')}>
            {x.icon}{x.label}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1">
        {/* Desktop: sidebar */}
        <nav className="hidden w-60 shrink-0 space-y-0.5 border-r border-line p-3 md:block">
          {sections.map(x => (
            <button key={x.id} onClick={() => go(x.id)}
              className={clsx('flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm transition',
                x.id === tab ? 'bg-white/10 font-medium text-fg' : 'text-muted hover:bg-white/5 hover:text-fg')}>
              {x.icon}{x.label}
            </button>
          ))}
        </nav>
        <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">
          <div className="pb-safe mx-auto max-w-3xl px-1 pb-10 pt-4 md:px-6 md:pt-8">
            <div className="px-4 pb-1">
              <h2 className="text-xl font-semibold">{section.label}</h2>
              <p className="mt-1 text-sm text-muted">{section.description}</p>
            </div>
            {tab === 'general' && <GeneralTab />}
            {tab === 'auto' && <div className="p-4"><AutoRouterSettings /></div>}
            {tab === 'save' && <SaveLocationTab />}
            {tab === 'users' && <UsersAdmin />}
            {tab === 'providers' && (
              <div className="space-y-3 p-4">
                {providers.map(p => <ProviderCard key={p.id} p={p} />)}
              </div>
            )}
            {tab === 'assist' && <PromptAssistSettings />}
            {tab === 'agents' && <AgentsSettings />}
            {tab === 'account' && <AccountTab />}
          </div>
        </main>
      </div>
    </div>,
    document.body,
  );
}
