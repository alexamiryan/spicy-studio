import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Search, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { queryClient } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import { Spinner, inputClass } from './ui';

interface RouterInfo {
  families: { key: string; name: string; modality: 'image' | 'video'; providers: string[]; models: { provider: string; name: string; uncensored: boolean }[] }[];
  selected: string[];
  credits: { id: string; name: string; unit: string; value: number | null; known: boolean }[];
}

const KEY = ['router'];

/**
 * Settings → General → Auto models: model families offered by several of the user's providers. Picked
 * ones appear at the top of the model picker and generate with the cheapest provider that has the balance.
 */
export function AutoRouterSettings() {
  const toast = useStore(s => s.toast);
  const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<RouterInfo>('/api/router') });
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const shown = useMemo(() => (data?.families || []).filter(f => !term || f.name.toLowerCase().includes(term)), [data, term]);

  async function save(patch: { models?: string[]; creditValues?: Record<string, number> }) {
    try {
      await api.patch('/api/router', patch);
      queryClient.invalidateQueries({ queryKey: KEY });
      queryClient.invalidateQueries({ queryKey: ['models'] });
    } catch (error) { toast(errorText(error), 'error'); }
  }
  function toggle(key: string) {
    const selected = data!.selected.includes(key) ? data!.selected.filter(k => k !== key) : [...data!.selected, key];
    queryClient.setQueryData<RouterInfo>(KEY, d => d && { ...d, selected });
    save({ models: selected });
  }

  return (
    <div className="space-y-3 rounded-2xl border border-line p-4">
      <div className="flex items-start gap-3">
        <Zap className="mt-0.5 size-5 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="font-semibold">Auto models</div>
          <p className="mt-1 text-sm text-muted">
            Pick models that several of your providers offer. They appear at the top of the model picker as <span className="text-fg">Auto</span>,
            and each generation goes to the provider where it's cheapest right now, if your balance there covers it.
            Uncensored versions are always preferred when one can take your inputs.
          </p>
        </div>
      </div>
      {isLoading ? <div className="flex justify-center py-6"><Spinner /></div> : !data?.families.length ? (
        <p className="text-sm text-faint">Connect at least two providers that offer the same models (e.g. SpicyAPI, Higgsfield, PoYo) to use Auto models.</p>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input className={clsx(inputClass, 'pl-9')} placeholder="Find a model…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {(['image', 'video'] as const).map(modality => {
            const list = shown.filter(f => f.modality === modality);
            if (!list.length) return null;
            return (
              <section key={modality}>
                <div className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-faint">{modality === 'image' ? 'Photo' : 'Video'}</div>
                <div className="grid items-start gap-1 sm:grid-cols-2">
                  {list.map(f => {
                    const on = data.selected.includes(f.key);
                    return (
                      <div key={f.key} className={clsx('rounded-xl border transition', on ? 'border-accent/40 bg-accent/10 sm:col-span-2' : 'border-line hover:bg-white/5')}>
                        <button onClick={() => toggle(f.key)} className="flex min-h-12 w-full items-center gap-2.5 px-3 py-2 text-left">
                          <span className={clsx('flex size-5 shrink-0 items-center justify-center rounded-md border', on ? 'border-accent bg-accent text-accent-fg' : 'border-white/30')}>
                            {on && <Check className="size-3.5" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{f.name}</span>
                            <span className="block truncate text-xs text-faint">{f.providers.join(' · ')} · {f.models.length} version{f.models.length === 1 ? '' : 's'}</span>
                          </span>
                        </button>
                        {on && (
                          // What this Auto model resolves to: every provider version it can choose from.
                          <ul className="space-y-1 border-t border-accent/20 px-3 py-2 text-xs">
                            {f.models.map(m => (
                              <li key={`${m.provider}:${m.name}`} className="flex items-center gap-2">
                                <span className="w-20 shrink-0 truncate text-faint">{m.provider}</span>
                                <span className="min-w-0 truncate">{m.name}</span>
                                {m.uncensored && <span className="shrink-0 rounded bg-fuchsia-400/15 px-1.5 text-[10px] font-medium text-fuchsia-300">uncensored · preferred</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {data.credits.length > 0 && (
            <div className="space-y-2 border-t border-line pt-3">
              <div className="text-sm font-medium">What a credit is worth</div>
              <p className="text-xs text-muted">Used to compare credit prices with dollar prices. Set it from your plan (price ÷ credits).</p>
              {data.credits.map(c => (
                <label key={c.id} className="flex items-center gap-3 text-sm">
                  <span className="w-28 shrink-0">{c.name}</span>
                  <span className="text-faint">$</span>
                  <input type="number" min={0} step={0.001} className={clsx(inputClass, 'h-10 w-32')} defaultValue={c.value ?? ''} placeholder="0.05"
                    onBlur={e => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v)) save({ creditValues: { [c.id]: v } }); }} />
                  <span className="text-xs text-faint">per {c.unit.replace(/s$/, '')}{c.known ? ' (published price)' : ''}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
