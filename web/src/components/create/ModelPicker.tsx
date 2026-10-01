import { clsx } from 'clsx';
import { AlertTriangle, Check, ChevronDown, Search, Sparkles, Star } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { selectModel } from '../../lib/actions';
import { keys, queryClient, useModels } from '../../lib/queries';
import { errorText, useStore } from '../../lib/store';
import type { Modality, ModelGroup, ModelInfo } from '../../lib/types';
import { Popover, Spinner, inputClass } from '../ui';

async function toggleFavorite(modelId: string, favorite: boolean) {
  const update = (list: string[]) => (favorite ? [...list, modelId] : list.filter(id => id !== modelId));
  for (const m of ['image', 'video'] as Modality[]) {
    queryClient.setQueryData<{ providers: ModelGroup[]; favorites: string[] }>(keys.models(m), d => d && { ...d, favorites: update(d.favorites) });
  }
  try {
    await api.put('/api/favorites/models', { modelId, favorite });
  } catch (error) {
    useStore.getState().toast(errorText(error), 'error');
    queryClient.invalidateQueries({ queryKey: ['models'] });
  }
}

function ModelRow({ model, providerName, selected, favorite, onPick }: {
  model: ModelInfo; providerName: string; selected: boolean; favorite: boolean; onPick: () => void;
}) {
  return (
    <div className={clsx('group flex items-center gap-1 rounded-xl pr-1', selected ? 'bg-accent/10' : 'hover:bg-white/6')}>
      <button onClick={onPick} disabled={!model.available} className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-2.5 py-2 text-left disabled:opacity-40">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={clsx('truncate text-sm font-medium', selected && 'text-accent')}>{model.name}</span>
            {selected && <Check className="size-4 shrink-0 text-accent" />}
          </div>
          <div className="truncate text-xs text-faint">
            {[model.vendor, providerName, model.price].filter(Boolean).join(' · ')}
            {!model.available && ' · unavailable'}
          </div>
        </div>
      </button>
      <button
        aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
        onClick={() => toggleFavorite(model.id, !favorite)}
        className={clsx('flex size-10 shrink-0 items-center justify-center rounded-lg transition hover:bg-white/8',
          favorite ? 'text-accent' : 'text-faint md:opacity-0 md:group-hover:opacity-100')}
      >
        <Star className={clsx('size-4', favorite && 'fill-current')} />
      </button>
    </div>
  );
}

export function ModelPicker({ modality, current, block, row }: { modality: Modality; current?: ModelInfo; block?: boolean; row?: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useModels(modality);
  const set = useStore(s => s.set);

  const { favorites, groups } = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (m: ModelInfo, provider: string) => {
      const hay = `${m.name} ${m.vendor || ''} ${provider} ${m.model}`.toLowerCase();
      return terms.every(t => hay.includes(t));
    };
    const groups = (data?.providers || []).map(p => ({ ...p, models: p.models.filter(m => match(m, p.name)) }));
    const all = groups.flatMap(g => g.models.map(m => ({ m, provider: g.name })));
    const favorites = (data?.favorites || []).map(id => all.find(x => x.m.id === id)).filter(Boolean) as { m: ModelInfo; provider: string }[];
    return { favorites, groups };
  }, [data, search]);

  const favSet = new Set(data?.favorites || []);
  const pick = (m: ModelInfo) => { selectModel(m); setOpen(false); setSearch(''); };
  const providerName = (id: string) => data?.providers.find(p => p.id === id)?.name || id;

  return (
    <Popover
      open={open}
      onOpenChange={o => { setOpen(o); if (!o) setSearch(''); }}
      title="Choose a model"
      width="w-[26rem]"
      trigger={row ? (
        // Settings-list row (phone create sheet): "Model   Wan 3.0 Prime · Higgsfield  ⌄"
        <button onClick={() => setOpen(!open)} className="flex min-h-12 w-full items-center gap-2 px-4 py-2 text-left text-sm active:bg-white/5">
          <Sparkles className="size-4 shrink-0 text-accent" />
          <span className="shrink-0 text-muted">Model</span>
          <span className="ml-auto min-w-0 text-right">
            <span className="block truncate font-medium">{current?.name || 'Choose model'}</span>
            {current && <span className="block truncate text-xs text-faint">{providerName(current.providerId)}</span>}
          </span>
          <ChevronDown className="size-4 shrink-0 text-faint" />
        </button>
      ) : (
        <button
          onClick={() => setOpen(!open)}
          className={clsx('flex h-9 min-w-0 items-center gap-2 rounded-xl border border-line bg-panel-3/60 px-3 text-sm hover:bg-white/10', block && 'h-12 w-full')}
        >
          <Sparkles className="size-4 shrink-0 text-accent" />
          <span className="truncate font-medium">{current?.name || 'Choose model'}</span>
          {current && <span className="hidden shrink-0 text-xs text-faint sm:inline">{providerName(current.providerId)}</span>}
          <ChevronDown className="ml-auto size-4 shrink-0 text-muted" />
        </button>
      )}
    >
      <div className="sticky top-0 z-10 -m-2 mb-1 bg-panel-2 p-2 max-md:bg-panel">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            autoFocus={!window.matchMedia('(pointer: coarse)').matches}
            className={clsx(inputClass, 'pl-9')}
            placeholder={`Search ${modality} models…`}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const first = favorites[0]?.m || groups.flatMap(g => g.models).find(m => m.available);
                if (first) pick(first);
              }
            }}
          />
        </div>
      </div>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {error && <div className="p-3 text-sm text-danger">{errorText(error)}</div>}
      {favorites.length > 0 && (
        <section className="mb-2">
          <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-faint"><Star className="size-3 fill-current" /> Favorites</div>
          {favorites.map(({ m, provider }) => (
            <ModelRow key={`fav-${m.id}`} model={m} providerName={provider} selected={current?.id === m.id} favorite onPick={() => pick(m)} />
          ))}
        </section>
      )}
      {groups.map(g => (
        <section key={g.id} className="mb-2">
          <div className="px-2.5 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-faint">{g.name}</div>
          {!g.configured || !g.enabled ? (
            <button onClick={() => { setOpen(false); set({ modal: { type: 'settings', tab: 'providers' } }); }} className="mx-2.5 mb-2 text-left text-sm text-muted underline-offset-2 hover:text-fg hover:underline">
              {g.configured ? `${g.name} is turned off. Enable it in Settings.` : `Connect ${g.name} in Settings to use its models.`}
            </button>
          ) : g.error ? (
            <div className="mx-2.5 mb-2 flex gap-2 text-sm text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{g.error}</div>
          ) : g.models.length === 0 ? (
            <div className="mx-2.5 mb-2 text-sm text-faint">{search ? 'No matches' : `No ${modality} models`}</div>
          ) : (
            g.models.map(m => <ModelRow key={m.id} model={m} providerName={g.name} selected={current?.id === m.id} favorite={favSet.has(m.id)} onPick={() => pick(m)} />)
          )}
        </section>
      ))}
    </Popover>
  );
}
