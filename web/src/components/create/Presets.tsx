import { clsx } from 'clsx';
import { Bookmark, Check, ChevronDown, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { cachedModel, deletePreset, loadPreset, renamePreset, savePreset, updatePreset } from '../../lib/actions';
import { usePresets } from '../../lib/queries';
import { errorText, useStore } from '../../lib/store';
import type { Preset } from '../../lib/types';
import { Button, Chip, Popover, Spinner, inputClass } from '../ui';

const modelLabel = (p: Preset) => cachedModel(p.modelId, p.modality)?.name || p.modelId.split(':').slice(1).join(':');

function PresetRow({ preset, active, onLoad }: { preset: Preset; active: boolean; onLoad: () => void }) {
  const toast = useStore(s => s.toast);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try { await fn(); if (done) toast(done, 'ok'); }
    catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(null); }
  };
  const refs = preset.refs.filter(r => r.thumbUrl).slice(0, 3);

  if (renaming !== null) {
    return (
      <form className="flex items-center gap-1.5 rounded-xl p-1.5"
        onSubmit={e => { e.preventDefault(); run('rename', () => renamePreset(preset, renaming)).then(() => setRenaming(null)); }}>
        <input className={clsx(inputClass, 'h-10')} value={renaming} onChange={e => setRenaming(e.target.value)} autoFocus maxLength={60}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }} />
        <Button size="sm" type="submit" loading={busy === 'rename'} disabled={!renaming.trim()}>Save</Button>
      </form>
    );
  }
  return (
    <div className={clsx('group flex items-center gap-1 rounded-xl', active ? 'bg-accent/10' : 'hover:bg-white/6')}>
      <button onClick={onLoad} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left">
        <span className="flex shrink-0 -space-x-3">
          {refs.length ? refs.map(r => <img key={r.id} src={r.thumbUrl!} alt="" className="size-9 rounded-lg border-2 border-panel-2 object-cover" />)
            : <span className="flex size-9 items-center justify-center rounded-lg bg-panel-3 text-muted"><Bookmark className="size-4" /></span>}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 truncate text-sm font-medium">{preset.name}{active && <Check className="size-3.5 shrink-0 text-accent" />}</span>
          <span className="block truncate text-xs text-faint">{modelLabel(preset)}{preset.prompt ? ` · ${preset.prompt}` : ''}</span>
        </span>
      </button>
      <div className="flex shrink-0 items-center pr-1 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
        <button title="Update with what's in the create box now" aria-label={`Update ${preset.name}`} onClick={() => {
          if (confirm(`Replace "${preset.name}" with what's in the create box now?`)) run('update', () => updatePreset(preset), `Updated "${preset.name}"`);
        }} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-white/8 hover:text-fg">
          {busy === 'update' ? <Spinner /> : <RefreshCw className="size-4" />}
        </button>
        <button title="Rename" aria-label={`Rename ${preset.name}`} onClick={() => setRenaming(preset.name)}
          className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-white/8 hover:text-fg"><Pencil className="size-4" /></button>
        <button title="Delete" aria-label={`Delete ${preset.name}`} onClick={() => {
          if (confirm(`Delete the preset "${preset.name}"? Your results and references are not affected.`)) run('delete', () => deletePreset(preset));
        }} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"><Trash2 className="size-4" /></button>
      </div>
    </div>
  );
}

/**
 * Presets: named create-box states ("Mirror selfie at home", "Outdoor posing"…) for the current workspace
 * and photo/video mode. Loading one fills the create box like Recreate, without hunting for an old result.
 */
export function PresetsControl({ row }: { row?: boolean }) {
  const { workspaceId: ws, toast } = useStore();
  const modality = useStore(s => s.draft.modality);
  const activeId = useStore(s => s.activePreset[s.draft.modality]);
  const { data: presets, isLoading } = usePresets(ws, modality);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const active = presets?.find(p => p.id === activeId);
  const kind = modality === 'video' ? 'video' : 'photo';

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try { const p = await savePreset(ws!, modality, name.trim()); toast(`Saved preset "${p.name}"`, 'ok'); setName(''); }
    catch (error) { toast(errorText(error), 'error'); }
    finally { setSaving(false); }
  }

  return (
    <Popover open={open} onOpenChange={setOpen} title={`${modality === 'video' ? 'Video' : 'Photo'} presets`} width="w-96" trigger={
      row
        ? <button className="flex h-12 w-full items-center gap-2 rounded-2xl border border-line bg-panel-2 px-4 text-left text-sm active:bg-white/5" onClick={() => setOpen(!open)}>
            <Bookmark className="size-4 text-accent" /><span className="text-muted">Preset</span>
            <span className="ml-auto truncate font-medium">{active?.name || (presets?.length ? `${presets.length} saved` : 'None yet')}</span><ChevronDown className="size-4 text-faint" />
          </button>
        : <Chip active={Boolean(active)} onClick={() => setOpen(!open)} title={`Saved ${kind} presets for this workspace`}>
            <Bookmark className="size-4" /><span className="max-w-36 truncate">{active?.name || 'Presets'}</span>
          </Chip>
    }>
      <div className="max-h-[50vh] space-y-0.5 overflow-y-auto">
        {isLoading ? <div className="flex justify-center py-6"><Spinner /></div>
          : presets?.length ? presets.map(p => (
            <PresetRow key={p.id} preset={p} active={p.id === activeId} onLoad={() => { setOpen(false); loadPreset(p); }} />
          )) : (
            <p className="px-2 py-3 text-sm text-faint">
              Save the create box as a preset to reuse it later, e.g. "Mirror selfie at home". It keeps the model, prompt, settings,
              references, folder and batch. {modality === 'video' ? 'Video' : 'Photo'} presets are listed separately and belong to this workspace.
            </p>
          )}
      </div>
      <form onSubmit={save} className="mt-2 flex items-center gap-1.5 border-t border-line pt-2">
        <input className={clsx(inputClass, 'h-10')} value={name} onChange={e => setName(e.target.value)} maxLength={60}
          placeholder={`Save current ${kind} setup as…`} />
        <Button type="submit" size="sm" variant="primary" loading={saving} disabled={!name.trim()}><Plus className="size-4" />Save</Button>
      </form>
    </Popover>
  );
}
