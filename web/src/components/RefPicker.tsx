import { clsx } from 'clsx';
import { Check, Film, Folder as FolderIcon, Loader2, Music, Play, RotateCcw, Save, Upload, X, ZoomIn } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { addRefsToDraft, cachedModel, environmentRefs, uploadEnvironments, uploadRefs } from '../lib/actions';
import { useFileDrop, usePasteFiles } from '../lib/fileInput';
import { keys, queryClient, useAssets, useEnvironments, useFolders, useRefs } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import type { Asset, Environment, MediaKind, Ref } from '../lib/types';
import { Button, Empty, IconButton, Modal, Segmented, Spinner, IdChip } from './ui';

type Tab = 'uploads' | 'model' | 'generated' | 'environments';
export type Item = { id: string; thumbUrl: string | null; url: string; kind: MediaKind; name: string; asset?: Asset; ref?: Ref; env?: Environment };

export const envItem = (e: Environment): Item => ({ id: e.id, thumbUrl: e.thumbUrl, url: e.url, kind: e.kind, name: e.name, env: e });

/** Workspace references for picked items: generated results and environment photos become references first. */
export async function itemsToRefs(workspaceId: string, items: Item[]): Promise<Ref[]> {
  const out: Ref[] = [];
  for (const item of items) {
    if (item.ref) out.push(item.ref);
    else if (item.env) out.push((await environmentRefs(workspaceId, [item.env.id]))[0]);
    else out.push(await api.post<Ref>('/api/refs/from-asset', { assetId: item.asset!.id }));
  }
  return out;
}

export function useInfiniteSentinel(query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(e => { if (e[0].isIntersecting && query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);
  return ref;
}

/** How an audio reference looks wherever a thumbnail would be: a music icon and its file name. */
export function AudioFace({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div className={clsx('flex size-full flex-col items-center justify-center bg-gradient-to-br from-violet-500/25 via-panel-2 to-sky-500/15 text-center',
      size === 'sm' ? 'gap-0.5 p-1' : size === 'lg' ? 'gap-3 p-6' : 'gap-1.5 p-2')}>
      <Music className={clsx('shrink-0 text-violet-300', size === 'sm' ? 'size-4' : size === 'lg' ? 'size-12' : 'size-6')} />
      <span className={clsx('line-clamp-2 leading-tight text-fg/90 [overflow-wrap:anywhere]', size === 'sm' ? 'text-[9px]' : size === 'lg' ? 'text-base' : 'text-[11px]')}>{name}</span>
    </div>
  );
}

/** Full-size look at a reference before picking it. Esc or a tap outside closes only the preview. */
export function Preview({ item, action, onClose }: {
  item: Pick<Item, 'url' | 'kind' | 'name'> & { id?: string }; action?: { label: string; primary?: boolean; onClick: () => void }; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="fade-in fixed inset-0 z-[55] flex flex-col bg-black/90 backdrop-blur-sm" onClick={onClose}>
      <div className="pt-safe flex items-center gap-2 p-2">
        <span className="min-w-0 flex-1 truncate px-2 text-sm text-muted">{item.name}</span>
        {/* The id, for telling an agent exactly which photo to use (names repeat). */}
        {item.id && <IdChip id={item.id} className="max-w-[55%] bg-black/40" />}
        <IconButton label="Close preview" className="bg-black/40 text-fg" onClick={onClose}><X className="size-5" /></IconButton>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-3" >
        {item.kind === 'audio' ? (
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-panel" onClick={e => e.stopPropagation()}>
            <div className="h-48"><AudioFace name={item.name} size="lg" /></div>
            <audio src={item.url} controls autoPlay className="w-full p-3" />
          </div>
        ) : item.kind === 'video'
          ? <video src={item.url} controls autoPlay loop playsInline className="max-h-full max-w-full" onClick={e => e.stopPropagation()} />
          : <img src={item.url} alt={item.name} className="max-h-full max-w-full rounded-lg object-contain" onClick={e => e.stopPropagation()} />}
      </div>
      {action && (
        <div className="pb-safe flex justify-center p-3">
          <Button variant={action.primary ? 'primary' : 'outline'} onClick={e => { e.stopPropagation(); action.onClick(); onClose(); }}>{action.label}</Button>
        </div>
      )}
    </div>,
    document.body,
  );
}

export function MediaTile({ item, selected, onClick, badge, saved, highlight }: {
  item: Item | Ref; selected?: boolean; onClick: () => void; badge?: number; saved?: boolean; highlight?: boolean;
}) {
  const [zoom, setZoom] = useState(false);
  return (
    <div className="card-cv relative">
      <button onClick={onClick} className={clsx('relative block aspect-square w-full overflow-hidden rounded-xl bg-panel-2 transition',
        selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-panel' : highlight && 'ring-2 ring-sky-400 ring-offset-2 ring-offset-panel')}>
        {item.kind === 'audio' ? <div className={clsx('size-full transition', selected && 'scale-90 overflow-hidden rounded-lg')}><AudioFace name={item.name} /></div> :
          item.thumbUrl ? <img src={item.thumbUrl} alt="" loading="lazy" className={clsx('size-full object-cover transition', selected && 'scale-90 rounded-lg')} /> :
          item.kind === 'video' ? <video src={`${item.url}#t=0.5`} muted playsInline preload="metadata" className="size-full object-cover" /> : null}
        {item.kind === 'video' && <Film className="absolute bottom-1.5 left-1.5 size-4 drop-shadow" />}
        {selected && <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-fg">{badge ?? <Check className="size-4" />}</span>}
        {saved && !selected && <span title="Saved" className="absolute right-1 top-1 rounded-md bg-black/60 p-0.5 backdrop-blur"><Save className="size-3 text-accent" /></span>}
        {highlight && <span className="absolute left-1 top-1 rounded-md bg-sky-500/90 px-1 text-[10px] font-semibold text-white">Source</span>}
      </button>
      <button
        aria-label={item.kind === 'audio' ? 'Play' : 'Zoom'}
        title={item.kind === 'audio' ? 'Play' : 'Zoom'}
        onClick={() => setZoom(true)}
        className="absolute bottom-1 right-1 flex size-8 items-center justify-center rounded-lg bg-black/55 text-fg backdrop-blur transition hover:bg-black/80"
      >
        {item.kind === 'audio' ? <Play className="size-4 fill-current" /> : <ZoomIn className="size-4" />}
      </button>
      {zoom && <Preview item={item} action={{ label: selected ? 'Deselect' : 'Select', primary: !selected, onClick }} onClose={() => setZoom(false)} />}
    </div>
  );
}

export function RefPicker() {
  const { modal, set, workspaceId: ws, draft, toast } = useStore();
  const open = modal?.type === 'refPicker';
  const fieldKey = open ? modal.fieldKey : '';
  const model = cachedModel(draft.models[draft.modality], draft.modality);
  const field = model?.refFields.find(f => f.key === fieldKey);
  const kind = field?.kind || 'image';
  const existing = (draft.refSlots[fieldKey] || []).length;
  const room = Math.max((field?.max ?? 1) - existing, 0);

  const [tab, setTab] = useState<Tab>('generated');
  const recreatedFrom = useStore(s => s.recreatedFrom);
  const [folder, setFolder] = useState('all');
  const [picked, setPicked] = useState<Item[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setPicked([]); setTab('generated'); } }, [open, fieldKey]);

  const refs = useRefs(open && (tab === 'model' || tab === 'uploads') ? ws : null, tab === 'model' ? 'model' : 'uploads', kind);
  const assets = useAssets(open && tab === 'generated' ? ws : null, folder, kind === 'audio' ? 'all' : kind);
  const environments = useEnvironments(open && tab === 'environments');
  const folders = useFolders(ws);
  const active = tab === 'generated' ? assets : tab === 'environments' ? environments : refs;
  const sentinel = useInfiniteSentinel(active);

  const items: Item[] = useMemo(() => tab === 'generated'
    ? (assets.data?.pages.flatMap(p => p.items) || []).map(a => ({ id: a.id, thumbUrl: a.thumbUrl, url: a.url, kind: a.kind, name: a.modelName, asset: a }))
    : tab === 'environments' ? (environments.data?.pages.flatMap(p => p.items) || []).map(envItem)
    : (refs.data?.pages.flatMap(p => p.items) || []).map(r => ({ id: r.id, thumbUrl: r.thumbUrl, url: r.url, kind: r.kind, name: r.name, ref: r })),
  [tab, assets.data, refs.data, environments.data]);

  function toggle(item: Item) {
    setPicked(p => {
      if (p.some(x => x.id === item.id)) return p.filter(x => x.id !== item.id);
      if (room === 1) return [item];
      if (p.length >= room) { toast(`You can add ${room} more here.`, 'error'); return p; }
      return [...p, item];
    });
  }

  async function onFiles(files: File[] | FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      const fitting = tab === 'environments'
        ? (await uploadEnvironments(files)).map(envItem)
        : (await uploadRefs(ws!, files, tab === 'model')).filter(r => r.kind === kind).map(r => ({ id: r.id, thumbUrl: r.thumbUrl, url: r.url, kind: r.kind, name: r.name, ref: r }));
      if (tab === 'generated') setTab('uploads'); // show what was just uploaded
      setPicked(p => [...p, ...fitting].slice(0, Math.max(room, 1)));
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  // The result last used for Recreate, offered first on the Generated tab (when it fits this input).
  const source: Item | null = tab === 'generated' && recreatedFrom && recreatedFrom.workspaceId === ws && recreatedFrom.kind === kind
    ? { id: recreatedFrom.id, thumbUrl: recreatedFrom.thumbUrl, url: recreatedFrom.url, kind: recreatedFrom.kind, name: recreatedFrom.modelName, asset: recreatedFrom }
    : null;

  usePasteFiles(onFiles, open);
  const drop = useFileDrop(onFiles, open);
  const pickable = room === 1 ? [] : items.slice(0, room);
  const allPicked = pickable.length > 0 && pickable.every(i => picked.some(p => p.id === i.id));

  async function confirm() {
    setBusy(true);
    try {
      addRefsToDraft(await itemsToRefs(ws!, picked), fieldKey);
      queryClient.invalidateQueries({ queryKey: keys.refs(ws!) });
      set({ modal: null });
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => set({ modal: null })}
      title={field ? `Add to ${field.label}` : 'Add reference'}
      full
      footer={
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">{picked.length ? `${picked.length} selected` : room ? `Up to ${room} ${kind}${room === 1 ? '' : 's'}` : 'This slot is full'}</span>
          <Button variant="primary" className="ml-auto" disabled={!picked.length} loading={busy} onClick={confirm}>Add{picked.length ? ` ${picked.length}` : ''}</Button>
        </div>
      }
    >
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
        <div className="no-scrollbar -my-1 max-w-full overflow-x-auto py-1">
          <Segmented value={tab} onChange={setTab} options={[
            { value: 'generated', label: 'Generated' }, { value: 'model', label: 'Model refs' }, { value: 'uploads', label: 'Uploads' },
            ...(kind === 'image' ? [{ value: 'environments' as const, label: 'Environments' }] : []),
          ]} />
        </div>
        {tab === 'generated' ? (
          <label className="flex h-10 items-center gap-2 rounded-xl border border-line bg-panel-2 px-3 text-sm">
            <FolderIcon className="size-4 text-muted" />
            <select className="bg-transparent outline-none" value={folder} onChange={e => setFolder(e.target.value)}>
              <option value="all">All folders</option>
              <option value="unsorted">Unsorted</option>
              {folders.data?.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
        ) : (
          <>
            <input ref={fileInput} type="file" multiple accept={kind === 'video' ? 'video/*' : kind === 'audio' ? 'audio/*' : 'image/*'} className="hidden" onChange={e => onFiles(e.target.files)} />
            <Button variant="outline" onClick={() => fileInput.current?.click()} loading={uploading}>
              {!uploading && <Upload className="size-4" />} Upload{tab === 'model' ? ' model refs' : ''}
            </Button>
          </>
        )}
        {pickable.length > 1 && (
          <Button variant="ghost" className="ml-auto" onClick={() => setPicked(allPicked ? [] : pickable)}
            title={items.length > room ? `Selects the first ${room} (the most this input takes)` : undefined}>
            {allPicked ? 'Clear selection' : items.length > room ? `Select ${room}` : 'Select all'}
          </Button>
        )}
      </div>
      <div className="relative min-h-[60%] p-4" {...drop.props}>
        {source && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-sky-400/40 bg-sky-400/5 p-2.5">
            <div className="w-20 shrink-0">
              <MediaTile item={source} selected={picked.some(p => p.id === source.id)} onClick={() => toggle(source)} saved={source.asset?.exported} />
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex items-center gap-1.5 font-medium"><RotateCcw className="size-4 text-sky-400" />You recreated from this</div>
              <div className="text-xs text-muted">Tap to add it as a reference.</div>
            </div>
          </div>
        )}
        {drop.over && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/10 font-medium text-accent">
            Drop to upload{tab === 'model' ? ' as model refs' : tab === 'environments' ? ' to environments' : ''}
          </div>
        )}
        {active.isLoading ? <div className="flex justify-center py-16"><Spinner /></div>
          : !items.length ? (
            <Empty title={tab === 'generated' ? 'No results in this folder' : tab === 'model' ? 'No model references yet' : tab === 'environments' ? 'No environments yet' : 'No uploads yet'}>
              {tab === 'model' ? 'Upload your influencer\'s face and body shots here to reuse them in every generation.'
                : tab === 'environments' ? 'Upload photos of real places once and use them as references in every workspace. Drag files here or paste an image (Ctrl+V).'
                : tab === 'uploads' ? 'Upload, drag files here, or paste an image (Ctrl+V).' : 'Pick another folder.'}
            </Empty>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {items.map(item => {
                const index = picked.findIndex(p => p.id === item.id);
                return <MediaTile key={item.id} item={item} selected={index >= 0} badge={index >= 0 ? existing + index + 1 : undefined} onClick={() => toggle(item)}
                  saved={item.asset?.exported} highlight={tab === 'generated' && item.id === source?.id} />;
              })}
            </div>
          )}
        <div ref={sentinel} className="flex h-12 items-center justify-center">{active.isFetchingNextPage && <Loader2 className="size-5 animate-spin text-muted" />}</div>
      </div>
    </Modal>
  );
}
