import { clsx } from 'clsx';
import { Check, ChevronDown, Library, LogOut, Plus, Settings, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { formatBalance } from '../lib/models';
import { queryClient, useBalances, useWorkspaces } from '../lib/queries';
import { useStore } from '../lib/store';
import type { Balance } from '../lib/types';
import { IconButton, Popover, useIsMobile } from './ui';

/** Share of the balance left since the last top-up (0–1), or null when unknown. */
const leftOf = (b: Balance) => (b.amount === null || !b.peak ? null : Math.max(0, Math.min(1, b.amount / b.peak)));

/** Red when empty, through amber, to green when full. */
const ringColor = (left: number) => `hsl(${Math.round(left * 120)} 85% 55%)`;

/** A provider's first letter in a ring that empties as the balance is spent. */
function BalanceRing({ b }: { b: Balance }) {
  const left = leftOf(b);
  const r = 13;
  const circumference = 2 * Math.PI * r;
  return (
    <span className="relative flex size-8 shrink-0 items-center justify-center">
      <svg viewBox="0 0 32 32" className="absolute inset-0 -rotate-90">
        <circle cx="16" cy="16" r={r} fill="none" stroke="currentColor" strokeWidth="3" className="text-white/10" />
        {left !== null && !b.error && (
          <circle cx="16" cy="16" r={r} fill="none" stroke={ringColor(left)} strokeWidth="3" strokeLinecap="round"
            strokeDasharray={`${Math.max(left * circumference, 0.01)} ${circumference}`} className="transition-[stroke-dasharray] duration-700" />
        )}
      </svg>
      <span className={clsx('relative text-[11px] font-bold', b.error ? 'text-danger' : 'text-fg')}>{b.error ? '!' : b.name.charAt(0).toUpperCase()}</span>
    </span>
  );
}

/**
 * Provider balances as rings in the header. Hovering (desktop) or tapping shows the numbers; tapping a row
 * opens that provider's settings (to top up or fix a key).
 */
function Balances() {
  const { data, isLoading } = useBalances();
  const set = useStore(s => s.set);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hoverable = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) { setOpen(false); setPinned(false); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setPinned(false); } };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  if (isLoading) return null;
  if (!data?.length) {
    return (
      <button onClick={() => set({ modal: { type: 'settings', tab: 'providers' } })} className="whitespace-nowrap rounded-xl border border-dashed border-line-strong px-3 py-1.5 text-xs text-muted hover:text-fg">
        Connect a provider
      </button>
    );
  }
  const low = data.some(b => !b.error && (leftOf(b) ?? 1) < 0.2);
  return (
    <div ref={ref} className="relative"
      onMouseEnter={() => hoverable && setOpen(true)} onMouseLeave={() => hoverable && !pinned && setOpen(false)}>
      <button onClick={() => { setPinned(!pinned || !open); setOpen(!(open && pinned)); }} aria-expanded={open}
        aria-label={`Balances${low ? ' (some are running low)' : ''}`}
        className="flex items-center gap-0.5 rounded-xl px-1 py-1 hover:bg-white/6 sm:gap-1">
        {data.map(b => <BalanceRing key={b.providerId} b={b} />)}
      </button>
      {open && (
        <div className="fade-in absolute right-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-line-strong bg-panel-2 p-1.5 shadow-2xl">
          {data.map(b => {
            const left = leftOf(b);
            return (
              <button key={b.providerId} onClick={() => { setOpen(false); setPinned(false); set({ modal: { type: 'settings', tab: 'providers' } }); }}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-white/6">
                <BalanceRing b={b} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm">{b.name}</span>
                    <span className={clsx('shrink-0 text-sm font-semibold tabular-nums', b.error && 'text-danger')}>{b.error ? 'Error' : formatBalance(b.amount, b.unit)}</span>
                  </span>
                  <span className="block text-xs leading-snug text-faint">
                    {b.error ? b.error : left !== null ? `${Math.round(left * 100)}% of ${formatBalance(b.peak!, b.unit)} since the last top-up` : b.detail || ''}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
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
