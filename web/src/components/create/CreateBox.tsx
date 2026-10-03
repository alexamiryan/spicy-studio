import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ChevronUp, Film, Image as ImageIcon, Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { addRefsToDraft, selectModel, uploadRefs } from '../../lib/actions';
import { formatCost } from '../../lib/models';
import { keys, queryClient, useModels, useWorkspaces } from '../../lib/queries';
import { useFileDrop, usePasteFiles } from '../../lib/fileInput';
import { errorText, useStore } from '../../lib/store';
import type { Generation, Modality, ModelField, ModelInfo } from '../../lib/types';
import { Button, IconButton, Modal, Segmented, useIsMobile } from '../ui';
import { ModelPicker } from './ModelPicker';
import { PresetsControl } from './Presets';
import { PromptInput } from './PromptInput';
import { RefTray } from './RefTray';
import { BatchControl, FolderControl, MoreSettings, SettingControl } from './SettingsControls';

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** The currently selected model, choosing a sensible default when none is set. */
function useCurrentModel(modality: Modality) {
  const { data } = useModels(modality);
  const { draft, workspaceId } = useStore();
  const { data: workspaces } = useWorkspaces();
  const selectedId = draft.models[modality];
  const all = useMemo(() => data?.providers.flatMap(p => p.models) || [], [data]);
  const current = all.find(m => m.id === selectedId);

  useEffect(() => {
    if (!data || current) return;
    const ws = workspaces?.find(w => w.id === workspaceId);
    const preferred = ws?.prefs[modality === 'image' ? 'imageModel' : 'videoModel'];
    const pick = all.find(m => m.id === preferred && m.available)
      || data.favorites.map(id => all.find(m => m.id === id)).find(m => m?.available)
      || all.find(m => m.available);
    if (pick && (!selectedId || !all.length || !all.some(m => m.id === selectedId))) selectModel(pick);
  }, [data, current, all, selectedId, workspaces, workspaceId, modality]);

  return current;
}

function payload(model: ModelInfo | undefined) {
  const { draft, workspaceId } = useStore.getState();
  if (!model) return null;
  return {
    workspaceId,
    modelId: model.id,
    prompt: draft.prompt,
    ...(draft.promptOriginal ? { originalPrompt: draft.promptOriginal } : {}),
    settings: draft.settings[model.id] || {},
    refSlots: Object.fromEntries(model.refFields.map(f => [f.key, (draft.refSlots[f.key] || []).map(r => r.id)])),
    folderId: draft.folderId,
    batch: draft.batch,
  };
}

function useQuote(model: ModelInfo | undefined) {
  const draft = useStore(s => s.draft);
  const key = useDebounced(model ? JSON.stringify({ m: model.id, s: draft.settings[model.id], b: draft.batch, r: Object.values(draft.refSlots).flat().map(r => r.id) }) : '', 600);
  return useQuery({
    queryKey: ['quote', key],
    enabled: Boolean(key),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const body = payload(model);
      return (await api.post<{ cost: { amount: number; unit: string; via?: string; modelName?: string; uncensored?: boolean } | null }>('/api/quote', { ...body, prompt: body?.prompt || 'preview' })).cost;
    },
  });
}

/** Provider name for an id, from the loaded model lists (e.g. where an Auto model was routed). */
function providerLabel(id?: string) {
  if (!id) return '';
  for (const key of [keys.models('image'), keys.models('video')]) {
    const data = queryClient.getQueryData<{ providers: { id: string; name: string }[] }>(key);
    const found = data?.providers.find(p => p.id === id);
    if (found) return found.name;
  }
  return id;
}

function useGenerate(model: ModelInfo | undefined) {
  const [busy, setBusy] = useState(false);
  const { toast, set, workspaceId, draft } = useStore();
  async function generate() {
    if (!model || busy) return;
    setBusy(true);
    try {
      const rows = await api.post<Generation[]>('/api/generations', payload(model)!);
      const via = model.providerId === 'auto' ? providerLabel(rows[0]?.providerId) : '';
      toast(`${rows.length > 1 ? `Started ${rows.length} generations` : 'Generation started'}${via ? ` on ${via}` : ''}`);
      set({ createOpen: false });
      queryClient.invalidateQueries({ queryKey: keys.active(workspaceId!) });
      const prefs = { folderId: draft.folderId, [model.modality === 'image' ? 'imageModel' : 'videoModel']: model.id };
      api.patch(`/api/workspaces/${workspaceId}`, { prefs }).then(() => queryClient.invalidateQueries({ queryKey: keys.workspaces })).catch(() => {});
      setTimeout(() => queryClient.invalidateQueries({ queryKey: keys.balances }), 4000);
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }
  return { generate, busy };
}

function ModalityTabs({ value, full }: { value: Modality; full?: boolean }) {
  const patchDraft = useStore(s => s.patchDraft);
  return (
    <Segmented
      className={full ? 'flex w-full [&>button]:h-10 [&>button]:flex-1 [&>button>span]:justify-center' : undefined}
      value={value}
      onChange={v => patchDraft({ modality: v })}
      options={[
        { value: 'image', label: <span className="flex items-center gap-1.5"><ImageIcon className="size-4" />Image</span> },
        { value: 'video', label: <span className="flex items-center gap-1.5"><Film className="size-4" />Video</span> },
      ]}
    />
  );
}

function GenerateButton({ model, className, size = 'md' }: { model?: ModelInfo; className?: string; size?: 'md' | 'lg' }) {
  const { generate, busy } = useGenerate(model);
  const batch = useStore(s => s.draft.batch);
  const quote = useQuote(model);
  return (
    <Button variant="primary" size={size} className={clsx('min-w-32', className)} onClick={generate} loading={busy} disabled={!model}
      title={quote.data?.via ? `${quote.data.uncensored ? 'Uncensored' : 'Cheapest'} right now: ${quote.data.modelName} on ${quote.data.via}` : undefined}>
      {!busy && <Wand2 className="size-4 shrink-0" />}
      {/* Price (and the provider Auto picked) on a second line, so the fixed-width button never truncates it. */}
      <span className="flex min-w-0 flex-col items-start leading-tight">
        <span>Generate{batch > 1 ? ` ×${batch}` : ''}</span>
        {quote.data && (
          <span className="max-w-full truncate text-[11px] font-semibold opacity-75">
            {formatCost(quote.data.amount, quote.data.unit)}{quote.data.via ? ` · ${quote.data.via}` : ''}
          </span>
        )}
      </span>
    </Button>
  );
}

// Settings people change most get a chip in the desktop box; the rest go under "More".
const PRIORITY = [/aspect/, /^resolution$|size|quality/, /duration/, /^mode$|style|variant/];
// The desktop box shows this many settings as chips (one line); the rest go under More.
const MAX_INLINE = 3;

function splitFields(model: ModelInfo) {
  const rank = (key: string) => { const i = PRIORITY.findIndex(re => re.test(key)); return i < 0 ? PRIORITY.length : i; };
  // Video duration is always a chip, whatever its type.
  const pinned = model.modality === 'video' ? model.fields.filter(f => /duration/i.test(f.key)) : [];
  const candidates = model.fields.filter(f => f.type === 'enum' && !f.advanced && !pinned.includes(f)).sort((a, b) => rank(a.key) - rank(b.key));
  const inline = new Set([...pinned, ...candidates.slice(0, Math.max(MAX_INLINE - pinned.length, 0))].map(f => f.key));
  let more = model.fields.filter(f => !inline.has(f.key));
  if (more.length === 1 && more[0].type !== 'text') { inline.add(more[0].key); more = []; }
  // Video: duration is the setting you change most, so it comes first.
  const first = (f: ModelField) => (pinned.includes(f) ? 0 : 1);
  return { inline: model.fields.filter(f => inline.has(f.key)).sort((a, b) => first(a) - first(b)), more };
}

function SettingsList({ model, row }: { model?: ModelInfo; row?: boolean }) {
  const { draft, patchDraft } = useStore();
  if (!model) return null;
  const values = draft.settings[model.id] || {};
  const setValue = (key: string, value: unknown) =>
    patchDraft({ settings: { ...draft.settings, [model.id]: { ...(useStore.getState().draft.settings[model.id] || {}), [key]: value } } });
  if (row) {
    return <>{model.fields.map(f => <SettingControl key={f.key} field={f} value={values[f.key]} onChange={v => setValue(f.key, v)} row />)}</>;
  }
  const { inline, more } = splitFields(model);
  return (
    <>
      {inline.map(f => <SettingControl key={f.key} field={f} value={values[f.key]} onChange={v => setValue(f.key, v)} />)}
      {more.length > 0 && <MoreSettings fields={more} values={values} onChange={setValue} />}
    </>
  );
}

/** Upload dropped or pasted files as references and attach them to the matching inputs. */
function useCreateBoxUploads(pasteEnabled: boolean) {
  const { workspaceId, toast } = useStore();
  const upload = async (files: File[]) => {
    if (files.length === 1) toast('Uploading…'); // bigger selections show the upload progress pill
    try {
      const refs = await uploadRefs(workspaceId!, files);
      // Images go to the main reference input, videos/audio to the first input of their kind.
      for (const kind of ['image', 'video', 'audio'] as const) {
        const group = refs.filter(r => r.kind === kind);
        if (group.length) addRefsToDraft(group);
      }
    } catch (error) { toast(errorText(error), 'error'); }
  };
  usePasteFiles(upload, pasteEnabled);
  return useFileDrop(upload);
}

function DockedCreateBox() {
  const modality = useStore(s => s.draft.modality);
  const draft = useStore(s => s.draft);
  const model = useCurrentModel(modality);
  const { generate } = useGenerate(model);
  const pasteEnabled = useStore(s => !s.modal && !s.viewer);
  const drop = useCreateBoxUploads(pasteEnabled);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 lg:left-56">
      <div
        {...drop.props}
        className={clsx('pointer-events-auto relative w-full max-w-4xl rounded-3xl border bg-panel/95 p-3 shadow-[0_20px_60px_-10px_rgba(0,0,0,0.8)] backdrop-blur-xl transition',
          drop.over ? 'border-accent' : 'border-line-strong')}
      >
        {drop.over && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-3xl bg-accent/10 text-sm font-medium text-accent backdrop-blur-[2px]">
            Drop to add as references
          </div>
        )}
        {/*
          Fixed zones, so every control is always in the same place (fixed widths, long names truncate):
          top = what (mode · preset · model), bottom = how and go (the model's settings · folder · batch · Generate).
        */}
        <div className="mb-2 flex items-center gap-1.5">
          <ModalityTabs value={modality} />
          <PresetsControl className="w-40" />
          <ModelPicker modality={modality} current={model} className="w-64" />
        </div>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <RefTray model={model} />
            <PromptInput model={model} onSubmit={generate} />
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-2 xl:flex-nowrap">
          <div className="flex min-h-9 w-full min-w-0 items-center gap-1.5 xl:w-auto xl:flex-1 [&>*]:shrink-0">
            <SettingsList model={model} />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <FolderControl className="w-36" />
            <BatchControl value={draft.batch} onChange={batch => useStore.getState().patchDraft({ batch })} />
            <GenerateButton model={model} className="w-52" />
          </div>
        </div>
      </div>
    </div>
  );
}

function MobileCreate() {
  const { draft, createOpen, set, patchDraft } = useStore();
  const pasteEnabled = useStore(s => s.createOpen && !s.modal);
  useCreateBoxUploads(pasteEnabled);
  const model = useCurrentModel(draft.modality);
  const { generate } = useGenerate(model);
  const refCount = Object.values(draft.refSlots).flat().length;
  return (
    <>
      <div className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 backdrop-blur-xl">
        <div className="flex items-center gap-2 p-2">
          <button onClick={() => set({ createOpen: true })} className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-2xl bg-panel-2 px-3 text-left">
            <Sparkles className="size-4 shrink-0 text-accent" />
            <span className={clsx('min-w-0 flex-1 truncate text-[15px]', !draft.prompt && 'text-faint')}>{draft.prompt || `Create ${draft.modality}…`}</span>
            {refCount > 0 && <span className="shrink-0 rounded-md bg-white/10 px-1.5 text-xs">{refCount} ref</span>}
            <ChevronUp className="size-4 shrink-0 text-muted" />
          </button>
          <IconButton label="Generate" className="size-12 bg-accent text-accent-fg hover:bg-accent hover:text-accent-fg" onClick={generate} disabled={!model}>
            <Wand2 className="size-5" />
          </IconButton>
        </div>
      </div>
      <Modal open={createOpen} onClose={() => set({ createOpen: false })} title="Create" full
        footer={<GenerateButton model={model} size="lg" className="w-full" />}>
        <div className="space-y-5 p-4">
          <div className="space-y-2">
            <ModalityTabs value={draft.modality} full />
            <PresetsControl row />
          </div>
          {Boolean(model?.refFields.length) && <RefTray model={model} layout="stacked" />}
          <section className="space-y-1.5">
            <h3 className="px-1 text-sm font-medium">Prompt</h3>
            <div className="rounded-2xl border border-line bg-panel-2 px-2">
              <PromptInput model={model} onSubmit={generate} rows={4} />
            </div>
          </section>
          <section className="space-y-1.5">
            <h3 className="px-1 text-sm font-medium">Settings</h3>
            {/* One grouped list instead of separate pills. */}
            <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel-2">
              <ModelPicker modality={draft.modality} current={model} row />
              <SettingsList model={model} row />
              <FolderControl row />
              <BatchControl value={draft.batch} onChange={batch => patchDraft({ batch })} row />
            </div>
            {model?.description && <p className="px-1 pt-1 text-xs text-faint">{model.description}</p>}
          </section>
        </div>
      </Modal>
    </>
  );
}

export function CreateBox() {
  const mobile = useIsMobile();
  return mobile ? <MobileCreate /> : <DockedCreateBox />;
}
