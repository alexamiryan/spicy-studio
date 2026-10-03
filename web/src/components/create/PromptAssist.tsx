import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Check, Images, Loader2, RotateCcw, Sparkles, Undo2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { errorText, useStore } from '../../lib/store';
import type { ModelInfo } from '../../lib/types';
import { Button } from '../ui';

export interface AssistInfo { configured: boolean; keyHint: string | null; model: string; houseRules: string; showRefs: boolean }
export const ASSIST_KEY = ['assist'];
export const useAssist = () => useQuery({ queryKey: ASSIST_KEY, queryFn: () => api.get<AssistInfo>('/api/assist'), staleTime: 60_000 });

interface Rewrite { prompt: string; warnings: string[]; model: string; cost: number | null; sawImages: boolean }

const shortModel = (id: string) => id.split('/').pop()!.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/**
 * ✨ Enhance: the prompt assistant (OpenRouter, Grok by default) rewrites the prompt for the selected model.
 * The rewrite is shown for review first; the user's own words are kept so they can go back to them.
 */
export function PromptAssist({ model }: { model?: ModelInfo }) {
  const { draft, patchDraft, workspaceId, set, toast } = useStore();
  const { data: assist } = useAssist();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Rewrite | null>(null);
  const [showRefs, setShowRefs] = useState<boolean | null>(null);
  const seeRefs = showRefs ?? assist?.showRefs ?? false;
  const hasRefs = Object.values(draft.refSlots).some(list => list.length);

  useEffect(() => {
    if (!result) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setResult(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [result]);

  async function rewrite() {
    if (!assist?.configured) { set({ modal: { type: 'settings', tab: 'assist' } }); return; }
    if (!model) { toast('Pick a model first.', 'error'); return; }
    // Rewrite from the user's own words, also when trying again after using a rewrite.
    const source = draft.promptOriginal ?? draft.prompt;
    if (!source.trim()) { toast('Write what you want first; the assistant rewrites it.', 'error'); return; }
    setBusy(true);
    try {
      setResult(await api.post<Rewrite>('/api/assist/enhance', {
        workspaceId, modelId: model.id, prompt: source, settings: draft.settings[model.id] || {},
        refSlots: Object.fromEntries(model.refFields.map(f => [f.key, (draft.refSlots[f.key] || []).map(r => r.id)])),
        showRefs: seeRefs,
      }));
    } catch (error) { toast(errorText(error), 'error'); }
    setBusy(false);
  }

  function use() {
    if (!result) return;
    patchDraft({ promptOriginal: draft.promptOriginal ?? draft.prompt, prompt: result.prompt });
    setResult(null);
  }

  return (
    <>
      {draft.promptOriginal != null && !result && (
        <button onClick={() => patchDraft({ prompt: draft.promptOriginal!, promptOriginal: null })}
          title="Go back to what you wrote" className="absolute -top-1 right-9 flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-faint hover:bg-white/8 hover:text-fg">
          <Undo2 className="size-3" />Your words
        </button>
      )}
      {/* Auto enhance: no preview; the rewrite becomes the first step of each generation. */}
      <button role="switch" aria-checked={Boolean(draft.autoEnhance)} aria-label="Auto enhance"
        onClick={() => (assist?.configured ? patchDraft({ autoEnhance: !draft.autoEnhance }) : set({ modal: { type: 'settings', tab: 'assist' } }))}
        title={draft.autoEnhance ? 'Auto enhance on: every generation rewrites your prompt first, without preview. Click to turn off.' : 'Auto enhance: rewrite the prompt as part of each generation, without preview'}
        className={clsx('absolute right-0 top-7 flex h-5 w-8 items-center justify-center rounded-md text-[9px] font-semibold uppercase tracking-wide transition',
          draft.autoEnhance ? 'bg-accent text-accent-fg' : 'text-faint hover:bg-white/8 hover:text-muted')}>
        Auto
      </button>
      <button onClick={rewrite} disabled={busy} aria-label="Enhance prompt"
        title={assist?.configured ? `Enhance: ${shortModel(assist.model)} rewrites your prompt for this model` : 'Enhance prompts with an AI assistant (set up in Settings)'}
        className={clsx('absolute -top-1 right-0 flex size-8 items-center justify-center rounded-lg transition',
          busy ? 'text-accent' : 'text-muted hover:bg-white/8 hover:text-accent')}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
      </button>

      {result && (
        <div className="fade-in absolute bottom-full left-0 right-0 z-40 mb-2 flex max-h-[min(34rem,70dvh)] flex-col rounded-2xl border border-line-strong bg-panel-2 shadow-2xl">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Sparkles className="size-4 shrink-0 text-accent" />
            <div className="min-w-0 flex-1 truncate text-xs text-muted">
              Rewritten by <span className="text-fg">{shortModel(result.model)}</span>
              {result.sawImages ? ' · saw your references' : ''}{result.cost ? ` · $${result.cost.toFixed(3)}` : ''}
            </div>
            <button onClick={() => setResult(null)} aria-label="Close" className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-fg"><X className="size-4" /></button>
          </div>
          {result.warnings.length > 0 && (
            <div className="flex gap-2 border-b border-line bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{result.warnings.join(' ')} Check the references before using it, or try again.</span>
            </div>
          )}
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 text-sm leading-relaxed">
            {highlight(result.prompt)}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
            {hasRefs && (
              <label className="mr-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted" title="Send the reference photos to the assistant so it can describe them. They go to OpenRouter and the model's provider.">
                <input type="checkbox" className="accent-[var(--color-accent)]" checked={seeRefs} onChange={e => setShowRefs(e.target.checked)} />
                <Images className="size-3.5" />Let it see references
              </label>
            )}
            <Button size="sm" variant="ghost" className="ml-auto" loading={busy} onClick={rewrite}>{!busy && <RotateCcw className="size-3.5" />}Try again</Button>
            <Button size="sm" variant="primary" onClick={use}><Check className="size-3.5" />Use it</Button>
          </div>
        </div>
      )}
    </>
  );
}

/** @ tokens in the accent colour, so it's easy to see they survived the rewrite. */
function highlight(text: string) {
  const parts = text.split(/((?:^|(?<=[^\w@]))@[A-Za-z][\w-]*)/g);
  return parts.map((p, i) => (p.startsWith('@') ? <span key={i} className="font-medium text-accent">{p}</span> : p));
}
