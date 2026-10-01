import { clsx } from 'clsx';
import { Check, ChevronDown, Library, LogOut, Plus, Settings, Settings2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { formatBalance } from '../lib/models';
import { queryClient, useBalances, useWorkspaces } from '../lib/queries';
import { useStore } from '../lib/store';
import { IconButton, Popover, useIsMobile } from './ui';

function Balances() {
  const { data, isLoading } = useBalances();
  const set = useStore(s => s.set);
  if (isLoading) return null;
  if (!data?.length) {
    return (
      <button onClick={() => set({ modal: { type: 'settings', tab: 'providers' } })} className="whitespace-nowrap rounded-xl border border-dashed border-line-strong px-3 py-1.5 text-xs text-muted hover:text-fg">
        Connect a provider
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1 sm:gap-1.5">
      {data.map(b => (
        <div
          key={b.providerId}
          title={b.error || [b.name, b.detail].filter(Boolean).join(' · ')}
          className={clsx('flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border border-line bg-panel-2 px-2.5 py-1.5 text-xs', b.error && 'border-danger/40')}
        >
          <span className="hidden text-muted sm:inline">{b.name}</span>
          <span className={clsx('font-semibold tabular-nums', b.error ? 'text-danger' : 'text-fg')}>{b.error ? '!' : formatBalance(b.amount, b.unit, true)}</span>
        </div>
      ))}
    </div>
  );
}

function WorkspaceSwitcher() {
  const { data: workspaces = [] } = useWorkspaces();
  const { workspaceId, setWorkspace, set } = useStore();
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const button = useRef<HTMLButtonElement>(null);
  const current = workspaces.find(w => w.id === workspaceId);
  const choose = (id: string) => { setWorkspace(id); setOpen(false); };
  const openSettings = (id?: string) => { setOpen(false); set({ modal: { type: 'workspace', id } }); };

  const trigger = (
    <button ref={button} onClick={() => setOpen(!open)} aria-expanded={open}
      className="flex h-10 max-w-full items-center gap-2 rounded-xl px-1.5 hover:bg-white/6 sm:max-w-xs sm:px-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-sm font-bold text-accent">
        {(current?.name || '?').slice(0, 1).toUpperCase()}
      </span>
      <span className="truncate text-sm font-semibold">{current?.name || 'Workspace'}</span>
      <ChevronDown className={clsx('size-4 shrink-0 text-muted transition', open && 'rotate-180')} />
    </button>
  );

  // Phones: a full-width panel dropping down from under the header, with big rows.
  if (mobile) {
    const top = open ? (button.current?.closest('header')?.getBoundingClientRect().bottom ?? 56) : 0;
    return (
      <>
        {trigger}
        {open && createPortal(
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)}>
            <div className="fade-in absolute inset-x-0 bottom-0 bg-black/50" style={{ top }} />
            <div
              className="drop-in absolute inset-x-2 max-h-[70dvh] overflow-y-auto rounded-2xl border border-line-strong bg-panel-2 p-1.5 shadow-2xl"
              style={{ top: top + 6 }}
              onClick={e => e.stopPropagation()}
            >
              {workspaces.map(w => (
                <div key={w.id} className={clsx('flex items-center rounded-xl', w.id === workspaceId && 'bg-white/6')}>
                  <button onClick={() => choose(w.id)} className="flex h-14 min-w-0 flex-1 items-center gap-3 px-3 text-left active:bg-white/8">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 font-bold text-accent">{w.name.slice(0, 1).toUpperCase()}</span>
                    <span className="truncate text-base font-medium">{w.name}</span>
                    {w.id === workspaceId && <Check className="ml-auto size-5 shrink-0 text-accent" />}
                  </button>
                  <button aria-label={`${w.name} settings`} onClick={() => openSettings(w.id)} className="flex size-14 shrink-0 items-center justify-center text-muted active:text-fg">
                    <Settings2 className="size-5" />
                  </button>
                </div>
              ))}
              <button onClick={() => openSettings()} className="flex h-14 w-full items-center gap-3 rounded-xl px-3 text-base text-muted active:bg-white/8">
                <span className="flex size-9 items-center justify-center rounded-lg border border-dashed border-line-strong"><Plus className="size-5" /></span>
                New workspace
              </button>
            </div>
          </div>,
          document.body,
        )}
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen} title="Workspaces" side="bottom" width="w-64" trigger={trigger}>
      <div className="space-y-0.5">
        {workspaces.map(w => (
          <div key={w.id} className="flex items-center">
            <button
              onClick={() => choose(w.id)}
              className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-left text-sm hover:bg-white/6"
            >
              <span className="truncate">{w.name}</span>
              {w.id === workspaceId && <Check className="ml-auto size-4 shrink-0 text-accent" />}
            </button>
            <IconButton label="Workspace settings" className="size-9" onClick={() => openSettings(w.id)}>
              <Settings2 className="size-4" />
            </IconButton>
          </div>
        ))}
        <button
          onClick={() => openSettings()}
          className="flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-sm text-muted hover:bg-white/6 hover:text-fg"
        >
          <Plus className="size-4" /> New workspace
        </button>
      </div>
    </Popover>
  );
}

export function Header({ username }: { username?: string }) {
  const set = useStore(s => s.set);
  const mobile = useIsMobile();
  const [menu, setMenu] = useState(false);

  async function logout() {
    await api.post('/api/auth/logout').catch(() => {});
    queryClient.clear();
    window.location.reload();
  }

  return (
    <header className="pt-safe sticky top-0 z-30 border-b border-line bg-bg">
      {/* Solid, no backdrop blur: iOS home-screen apps render blurred sticky bars washed out. */}
      <div className="flex h-14 items-center gap-2 px-3 md:px-4">
        <img src="/icon.svg" alt="" className="hidden size-8 md:block" />
        {/* The workspace name takes whatever room is left and truncates; balances and icons never wrap. */}
        <div className="min-w-0 flex-1"><WorkspaceSwitcher /></div>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <Balances />
          <IconButton label="References & elements" onClick={() => set({ modal: { type: 'library' } })}><Library className="size-5" /></IconButton>
          {mobile ? (
            <Popover open={menu} onOpenChange={setMenu} side="bottom" align="right" title={username || 'Menu'} trigger={
              <IconButton label="Menu" onClick={() => setMenu(!menu)}><Settings className="size-5" /></IconButton>
            }>
              <button className="flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left hover:bg-white/6" onClick={() => { setMenu(false); set({ modal: { type: 'settings' } }); }}>
                <Settings className="size-5 text-muted" /> Settings
              </button>
              <button className="flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-danger hover:bg-white/6" onClick={logout}>
                <LogOut className="size-5" /> Sign out
              </button>
            </Popover>
          ) : (
            <>
              <IconButton label="Settings" onClick={() => set({ modal: { type: 'settings' } })}><Settings className="size-5" /></IconButton>
              <IconButton label={`Sign out${username ? ` (${username})` : ''}`} onClick={logout}><LogOut className="size-5" /></IconButton>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
