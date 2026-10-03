import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Eye, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { queryClient } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import { ASSIST_KEY, useAssist, type AssistInfo } from './create/PromptAssist';
import { Button, Field, Spinner, inputClass } from './ui';

interface AssistModel { id: string; name: string; vision: boolean; input: number; output: number }

/** Settings → Prompt assistant: OpenRouter key, the model that rewrites prompts, and standing preferences. */
export function PromptAssistSettings() {
  const toast = useStore(s => s.toast);
  const { data, isLoading } = useAssist();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<string | null>(null);

  async function save(patch: Partial<AssistInfo>) {
    try { queryClient.setQueryData(ASSIST_KEY, await api.patch<AssistInfo>('/api/assist', patch)); }
    catch (error) { toast(errorText(error), 'error'); }
  }
  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      queryClient.setQueryData(ASSIST_KEY, await api.put<AssistInfo>('/api/assist/key', { apiKey: key }));
      setKey('');
      toast('OpenRouter connected');
    } catch (error) { toast(errorText(error), 'error'); }
    setBusy(false);
  }
  async function removeKey() {
    if (!confirm('Remove the OpenRouter key? Enhance stops working until you add one again.')) return;
    queryClient.setQueryData(ASSIST_KEY, await api.del<AssistInfo>('/api/assist/key'));
  }

  if (isLoading || !data) return <div className="flex justify-center py-10"><Spinner /></div>;

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-3 rounded-2xl border border-line p-4">
        <p className="text-sm text-muted">
          Write what you want the way you always do and press <span className="text-fg">✨</span> in the prompt box: the assistant rewrites it
          into a detailed prompt for the selected model, keeping every <span className="text-accent">@image</span> and
          <span className="text-accent"> @element</span> link and what each is for. You review it before it's used, and can always go back to your words.
          It runs through <a className="text-accent hover:underline" href="https://openrouter.ai" target="_blank" rel="noreferrer">OpenRouter</a> (about 1–2¢ per rewrite with Grok).
        </p>
        {data.configured ? (
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-sm"><Check className="size-4 shrink-0 text-accent" />Connected · {data.keyHint}</div>
            <Button size="sm" variant="ghost" onClick={removeKey}>Remove</Button>
          </div>
        ) : (
          <form onSubmit={saveKey} className="flex gap-2">
            <input className={inputClass} type="password" autoComplete="off" placeholder="OpenRouter key (sk-or-…)" value={key} onChange={e => setKey(e.target.value)} />
            <Button type="submit" variant="primary" loading={busy} disabled={!key.trim()}>Connect</Button>
          </form>
        )}
        {!data.configured && <p className="text-xs text-faint">Create a key at openrouter.ai/keys and add credits; the key is stored encrypted.</p>}
      </div>

      <div className="space-y-4 rounded-2xl border border-line p-4">
        <Field label="Model" hint="Grok rewrites explicit prompts without watering them down. Models marked with the eye can look at references.">
          <ModelChooser value={data.model} onChange={model => save({ model })} />
        </Field>
        <Field label="Your standing preferences" hint="Added to every rewrite unless the prompt says otherwise, e.g. 'Amateur iPhone look, low-light noise. Videos: no talking, no music.' Each workspace can add its own in Workspace settings.">
          <textarea className={clsx(inputClass, 'h-auto min-h-24 py-2.5 leading-relaxed')} rows={4} maxLength={4000}
            value={rules ?? data.houseRules} onChange={e => setRules(e.target.value)}
            onBlur={() => { if (rules !== null && rules !== data.houseRules) save({ houseRules: rules }); }} />
        </Field>
        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={data.showRefs} onChange={e => save({ showRefs: e.target.checked })} />
          <span className="text-sm">
            Let it see references by default
            <span className="block text-xs text-faint">It can then describe your actual environment, outfit and body instead of guessing. The photos go to OpenRouter and the model's provider. You can switch it per rewrite.</span>
          </span>
        </label>
      </div>
    </div>
  );
}

function ModelChooser({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data: models = [], isLoading } = useQuery({ queryKey: ['assistModels'], queryFn: () => api.get<AssistModel[]>('/api/assist/models'), staleTime: 3600_000 });
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const current = models.find(m => m.id === value);
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = models.filter(m => !term || m.name.toLowerCase().includes(term) || m.id.includes(term));
    // xAI's models first: they're the reason for this feature.
    return [...list.filter(m => m.id.startsWith('x-ai/')), ...list.filter(m => !m.id.startsWith('x-ai/'))].slice(0, 80);
  }, [models, search]);
  return (
    <div className="space-y-2">
      <button type="button" onClick={() => setOpen(!open)} className={clsx(inputClass, 'flex items-center gap-2 text-left')}>
        <span className="min-w-0 flex-1 truncate">{current?.name || value}</span>
        {current?.vision && <Eye className="size-4 shrink-0 text-muted" />}
        <span className="shrink-0 text-xs text-faint">{current ? `$${current.input}/$${current.output} per M` : ''}</span>
      </button>
      {open && (
        <div className="rounded-xl border border-line bg-panel-2 p-2">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input className={clsx(inputClass, 'h-10 pl-9')} autoFocus placeholder="Search models…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {isLoading ? <div className="flex justify-center py-4"><Spinner /></div> : (
            <div className="scrollbar-thin max-h-72 overflow-y-auto">
              {shown.map(m => (
                <button key={m.id} type="button" onClick={() => { onChange(m.id); setOpen(false); setSearch(''); }}
                  className={clsx('flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm', m.id === value ? 'bg-white/10' : 'hover:bg-white/6')}>
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  {m.vision && <Eye className="size-3.5 shrink-0 text-muted" aria-label="Can see images" />}
                  <span className="shrink-0 text-[11px] text-faint">${m.input}/${m.output}</span>
                </button>
              ))}
              {!shown.length && <p className="px-2 py-3 text-sm text-faint">No models match.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
