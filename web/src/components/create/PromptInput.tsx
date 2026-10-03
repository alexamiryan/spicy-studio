import { clsx } from 'clsx';
import { Boxes } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { primaryRefField } from '../../lib/models';
import { useElements } from '../../lib/queries';
import { useStore } from '../../lib/store';
import { PromptAssist } from './PromptAssist';
import type { ModelInfo } from '../../lib/types';

interface Suggestion { token: string; label: string; thumb?: string | null; hint: string }

const MENTION_BEFORE_CARET = /(^|[^\w@])@([\w-]*)$/;

export function PromptInput({ model, onSubmit, rows = 2, autoFocus }: { model?: ModelInfo; onSubmit: () => void; rows?: number; autoFocus?: boolean }) {
  const { workspaceId, draft, patchDraft } = useStore();
  const { data: elements = [] } = useElements(workspaceId);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // Keep the keyboard-highlighted suggestion visible in the scrolling list.
  useEffect(() => { (list.current?.children[highlight] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }); }, [highlight]);

  const primary = primaryRefField(model);
  const images = primary ? draft.refSlots[primary.key] || [] : [];

  const suggestions = useMemo<Suggestion[]>(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    const list: Suggestion[] = [
      ...images.map((r, i) => ({ token: `image${i + 1}`, label: `@image${i + 1}`, thumb: r.thumbUrl, hint: r.name })),
      ...(primary || model?.nativeElements ? elements.map(e => ({
        token: e.name, label: `@${e.name}`, thumb: e.refs[0]?.thumbUrl,
        hint: `Element · ${e.refs.length} photo${e.refs.length === 1 ? '' : 's'}${model?.nativeElements ? ` · sent to ${model.providerId === 'higgsfield' ? 'Higgsfield' : 'the model'} as an element` : ''}`,
      })) : []),
    ];
    return list.filter(s => s.token.toLowerCase().startsWith(q) || (q.length > 1 && s.hint.toLowerCase().includes(q)));
  }, [query, images, elements, primary, model]);

  // Auto-grow up to a limit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft.prompt]);

  useEffect(() => setHighlight(0), [query]);

  function detect() {
    const el = ref.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const m = MENTION_BEFORE_CARET.exec(before);
    setQuery(m ? m[2] : null);
  }

  function insert(s: Suggestion) {
    const el = ref.current!;
    const caret = el.selectionStart;
    const before = el.value.slice(0, caret).replace(/@[\w-]*$/, `@${s.token} `);
    const next = before + el.value.slice(caret).replace(/^[\w-]*\s?/, '');
    patchDraft({ prompt: next });
    setQuery(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(before.length, before.length); });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => (h + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => (h - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(suggestions[highlight]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={rows}
        autoFocus={autoFocus}
        value={draft.prompt}
        onChange={e => { patchDraft({ prompt: e.target.value, ...(e.target.value.trim() ? {} : { promptOriginal: null }) }); requestAnimationFrame(detect); }}
        onKeyDown={onKeyDown}
        onClick={detect}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        placeholder={primary ? 'Describe the scene… @ to mention a reference · paste or drop images' : 'Describe what you want to create…'}
        className="scrollbar-thin block w-full resize-none bg-transparent py-2 pl-1 pr-9 text-[15px] leading-relaxed text-fg outline-none placeholder:text-faint"
      />
      <PromptAssist model={model} />
      {suggestions.length > 0 && (
        <div ref={list} className="fade-in scrollbar-thin absolute bottom-full left-0 z-40 mb-2 max-h-[min(22rem,50dvh)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-2xl border border-line-strong bg-panel-2 p-1.5 shadow-2xl">
          {suggestions.map((s, i) => (
            <button
              key={s.token}
              onMouseDown={e => e.preventDefault()}
              onClick={() => insert(s)}
              className={clsx('flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left', i === highlight ? 'bg-white/10' : 'hover:bg-white/6')}
            >
              <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-panel-3">
                {s.thumb ? <img src={s.thumb} alt="" className="size-full object-cover" /> : <Boxes className="size-4 text-muted" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-accent">{s.label}</span>
                <span className="block truncate text-xs text-faint">{s.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
