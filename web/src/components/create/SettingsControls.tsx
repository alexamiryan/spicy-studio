import { clsx } from 'clsx';
import { Check, ChevronDown, Copy, Folder as FolderIcon, FolderPlus, Search, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { createFolder } from '../../lib/actions';
import { fieldDisplay } from '../../lib/models';
import { useFolders } from '../../lib/queries';
import { errorText, useStore } from '../../lib/store';
import type { ModelField } from '../../lib/types';
import { Chip, Popover, inputClass } from '../ui';

function RatioIcon({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(':').map(Number);
  if (!w || !h) return null;
  const scale = 14 / Math.max(w, h);
  return <span className="inline-block rounded-[3px] border-[1.5px] border-current" style={{ width: Math.max(w * scale, 5), height: Math.max(h * scale, 5) }} />;
}

const shortLabel = (field: ModelField) => field.label.replace(/\s*\(.*\)$/, '').replace(/\s+seconds$/i, '');

export function SettingControl({ field, value, onChange, row }: {
  field: ModelField; value: unknown; onChange: (v: unknown) => void; row?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isRatio = /aspect/i.test(field.key);
  const display = fieldDisplay(field, value);

  const triggerContent = (
    <>
      {isRatio && typeof value === 'string' && <RatioIcon ratio={value} />}
      {row ? (
        <>
          <span className="text-muted">{shortLabel(field)}</span>
          <span className="ml-auto truncate font-medium">{display}</span>
        </>
      ) : (
        <span className="max-w-40 truncate">{isRatio ? display : <><span className="text-muted">{shortLabel(field)}</span> {display}</>}</span>
      )}
    </>
  );
  const rowClass = 'flex h-12 w-full items-center gap-2 px-4 text-left text-sm active:bg-white/5';

  if (field.type === 'boolean') {
    const on = Boolean(value);
    return row ? (
      <button className={rowClass} onClick={() => onChange(!on)}>
        <span className="text-muted">{shortLabel(field)}</span>
        <span className={clsx('ml-auto flex h-6 w-10 items-center rounded-full p-0.5 transition', on ? 'bg-accent' : 'bg-white/15')}>
          <span className={clsx('size-5 rounded-full bg-white shadow transition', on && 'translate-x-4')} />
        </span>
      </button>
    ) : (
      <Chip active={on} onClick={() => onChange(!on)} title={field.description}>{shortLabel(field)}{on ? ' on' : ' off'}</Chip>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title={field.label}
      width={field.type === 'text' ? 'w-96' : 'w-64'}
      trigger={row
        ? <button className={rowClass} onClick={() => setOpen(!open)}>{triggerContent}<ChevronDown className="size-4 shrink-0 text-faint" /></button>
        : <Chip onClick={() => setOpen(!open)} title={field.description}>{triggerContent}</Chip>}
    >
      {field.description && <p className="px-2 pb-2 text-xs text-faint">{field.description}</p>}
      {field.type === 'enum' && (
        <div className={clsx('grid gap-1', (field.options?.length || 0) > 8 ? 'grid-cols-4' : (field.options?.length || 0) > 6 && isRatio ? 'grid-cols-3' : 'grid-cols-1')}>
          {!field.required && field.default === undefined && (
            <button onClick={() => { onChange(undefined); setOpen(false); }} className="flex h-10 items-center gap-2 rounded-lg px-3 text-sm text-muted hover:bg-white/6">Auto</button>
          )}
          {field.options?.map(o => (
            <button
              key={String(o)}
              onClick={() => { onChange(o); setOpen(false); }}
              className={clsx('flex h-10 items-center gap-2 rounded-lg px-3 text-sm hover:bg-white/6', String(value) === String(o) && 'bg-accent/10 text-accent')}
            >
              {isRatio && <RatioIcon ratio={String(o)} />}
              {fieldDisplay(field, o)}
              {String(value) === String(o) && !isRatio && <Check className="ml-auto size-4" />}
            </button>
          ))}
        </div>
      )}
      {(field.type === 'number' || field.type === 'integer') && (
        <div className="space-y-3 p-2">
          {field.min !== undefined && field.max !== undefined && (
            <div className="space-y-1">
              <input
                type="range" className="w-full accent-[var(--color-accent)]" min={field.min} max={field.max}
                step={field.step ?? (field.type === 'integer' ? 1 : (field.max - field.min) / 100)}
                value={typeof value === 'number' && value >= field.min ? value : Number(field.default ?? field.min)}
                onChange={e => onChange(field.type === 'integer' ? Math.round(Number(e.target.value)) : Number(e.target.value))}
              />
              <div className="flex justify-between text-[11px] text-faint">
                <span>{fieldDisplay(field, field.min)}</span>
                <span className="font-medium text-fg">{fieldDisplay(field, value ?? field.default)}</span>
                <span>{fieldDisplay(field, field.max)}</span>
              </div>
            </div>
          )}
          {field.optionLabels && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(field.optionLabels).map(([v, label]) => (
                <button key={v} onClick={() => onChange(Number(v))}
                  className={clsx('h-8 rounded-lg px-3 text-sm', String(value) === v ? 'bg-accent/15 text-accent' : 'bg-panel-3 hover:bg-white/10')}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <input
            type="number" inputMode="decimal" className={inputClass} min={field.min} max={field.max} step={field.step ?? 'any'}
            value={typeof value === 'number' ? value : ''} placeholder="Auto"
            onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </div>
      )}
      {(field.type === 'string' || field.type === 'text') && (
        <div className="p-2">
          {field.type === 'text' ? (
            <textarea className={clsx(inputClass, 'h-28 py-2')} value={String(value ?? '')} onChange={e => onChange(e.target.value || undefined)} />
          ) : (
            <input className={inputClass} value={String(value ?? '')} onChange={e => onChange(e.target.value || undefined)} />
          )}
        </div>
      )}
    </Popover>
  );
}

export function BatchControl({ value, onChange, row }: { value: number; onChange: (n: number) => void; row?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} title="Number of generations" width="w-52" trigger={
      row
        ? <button className="flex h-12 w-full items-center gap-2 px-4 text-left text-sm active:bg-white/5" onClick={() => setOpen(!open)}><Copy className="size-4 text-muted" /><span className="text-muted">Batch</span><span className="ml-auto font-medium">{value}</span></button>
        : <Chip onClick={() => setOpen(!open)} title="Number of generations"><Copy className="size-4" />{value}</Chip>
    }>
      <div className="grid grid-cols-3 gap-1 p-1">
        {[1, 2, 3, 4, 6, 8].map(n => (
          <button key={n} onClick={() => { onChange(n); setOpen(false); }} className={clsx('h-11 rounded-lg text-sm font-medium hover:bg-white/8', n === value && 'bg-accent/15 text-accent')}>{n}</button>
        ))}
      </div>
    </Popover>
  );
}

export function FolderControl({ row, className }: { row?: boolean; className?: string }) {
  const { workspaceId: ws, draft, patchDraft, toast } = useStore();
  const { data } = useFolders(ws);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [naming, setNaming] = useState<string | null>(null); // inline "New folder" field
  const folders = [...(data?.folders || [])];
  const current = folders.find(f => f.id === draft.folderId);
  const term = search.trim().toLowerCase();
  const filtered = folders.filter(f => f.name.toLowerCase().includes(term));
  const exact = folders.some(f => f.name.toLowerCase() === term);

  async function create(name: string) {
    if (!name.trim()) return;
    try {
      const folder = await createFolder(ws!, name.trim());
      choose(folder.id);
    } catch (error) { toast(errorText(error), 'error'); }
  }
  const choose = (id: string | null) => { patchDraft({ folderId: id }); setOpen(false); setSearch(''); setNaming(null); };
  const exactMatch = folders.find(f => f.name.toLowerCase() === term);

  return (
    <Popover open={open} onOpenChange={o => { setOpen(o); if (!o) { setSearch(''); setNaming(null); } }} title="Save generations to folder" width="w-64" trigger={
      row
        ? <button className="flex h-12 w-full items-center gap-2 px-4 text-left text-sm active:bg-white/5" onClick={() => setOpen(!open)}><FolderIcon className="size-4 text-muted" /><span className="text-muted">Folder</span><span className="ml-auto truncate font-medium">{current?.name || 'Unsorted'}</span><ChevronDown className="size-4 text-faint" /></button>
        : <Chip active={Boolean(current)} onClick={() => setOpen(!open)} title={current ? `Folder for new generations: ${current.name}` : 'Folder for new generations'} className={className}><FolderIcon className="size-4 shrink-0" /><span className="min-w-0 truncate">{current?.name || 'No folder'}</span></Chip>
    }>
      <div className="relative mb-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <input
          className={clsx(inputClass, 'pl-9')} placeholder="Find or create folder…" value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter' || !term) return;
            if (exactMatch) choose(exactMatch.id);
            else if (filtered.length === 1) choose(filtered[0].id);
            else create(search);
          }}
        />
      </div>
      {term && !exact && (
        <button onClick={() => create(search)} className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm text-accent hover:bg-white/6">
          <FolderPlus className="size-4" /> Create “{search.trim()}”
        </button>
      )}
      {!term && (naming === null ? (
        <button onClick={() => setNaming('')} className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm text-accent hover:bg-white/6">
          <FolderPlus className="size-4" /> New folder
        </button>
      ) : (
        <form className="flex items-center gap-1.5 p-1" onSubmit={e => { e.preventDefault(); create(naming); }}>
          <input
            autoFocus className={clsx(inputClass, 'h-9')} placeholder="Folder name" value={naming}
            onChange={e => setNaming(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }}
          />
          <button type="submit" disabled={!naming.trim()} aria-label="Create folder"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg disabled:opacity-40">
            <Check className="size-4" />
          </button>
        </form>
      ))}
      {!term && (
        <button onClick={() => choose(null)} className={clsx('flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm hover:bg-white/6', !current && 'text-accent')}>
          No folder (Unsorted){!current && <Check className="ml-auto size-4" />}
        </button>
      )}
      {filtered.map(f => (
        <button key={f.id} onClick={() => choose(f.id)} className={clsx('flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm hover:bg-white/6', f.id === draft.folderId && 'text-accent')}>
          <FolderIcon className="size-4 shrink-0 text-muted" /><span className="truncate">{f.name}</span>
          <span className="ml-auto text-xs text-faint">{f.count}</span>
        </button>
      ))}
    </Popover>
  );
}

/** Compact always-visible control, used inside the desktop "More" panel (no nested popovers). */
function InlineControl({ field, value, onChange }: { field: ModelField; value: unknown; onChange: (v: unknown) => void }) {
  const control = 'h-9 rounded-lg border border-line bg-panel-3 px-2 text-sm text-fg outline-none focus:border-accent/60';
  if (field.type === 'boolean') {
    const on = Boolean(value);
    return (
      <button role="switch" aria-checked={on} aria-label={field.label} onClick={() => onChange(!on)}
        className={clsx('flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition', on ? 'bg-accent' : 'bg-white/15')}>
        <span className={clsx('size-5 rounded-full bg-white shadow transition', on && 'translate-x-4')} />
      </button>
    );
  }
  if (field.type === 'enum') {
    return (
      <select className={clsx(control, 'max-w-40')} value={value === undefined || value === null ? '' : String(value)}
        onChange={e => onChange(e.target.value === '' ? undefined : field.options!.find(o => String(o) === e.target.value))}>
        {!field.required && field.default === undefined && <option value="">Auto</option>}
        {field.options!.map(o => <option key={String(o)} value={String(o)}>{fieldDisplay(field, o)}</option>)}
      </select>
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    return (
      <input type="number" className={clsx(control, 'w-24')} min={field.min} max={field.max} step={field.step ?? 'any'} placeholder="Auto"
        value={typeof value === 'number' ? value : ''} onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    );
  }
  return (
    <input className={clsx(control, 'w-44')} placeholder={field.placeholder || 'Optional'} value={String(value ?? '')}
      onChange={e => onChange(e.target.value || undefined)} />
  );
}

/** "More" chip holding the less common settings, so the create box stays one tidy row. */
export function MoreSettings({ fields, values, onChange }: { fields: ModelField[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const changed = fields.filter(f => values[f.key] !== undefined && values[f.key] !== f.default).length;
  return (
    <Popover open={open} onOpenChange={setOpen} title="More settings" width="w-96" trigger={
      <Chip active={changed > 0} onClick={() => setOpen(!open)} title="More settings">
        <SlidersHorizontal className="size-4" />More{changed > 0 ? ` · ${changed}` : ''}
      </Chip>
    }>
      <div className="divide-y divide-line">
        {fields.map(f => (
          <label key={f.key} className="flex min-h-12 items-center gap-3 px-2 py-1.5" title={f.description}>
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{f.label}</span>
              {f.description && <span className="line-clamp-2 block text-xs text-faint">{f.description}</span>}
            </span>
            <InlineControl field={f} value={values[f.key]} onChange={v => onChange(f.key, v)} />
          </label>
        ))}
      </div>
    </Popover>
  );
}
