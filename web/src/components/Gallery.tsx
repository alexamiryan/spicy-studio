import { clsx } from 'clsx';
import {
  AlertTriangle, Check, CheckSquare, Clock, Film, Folder as FolderIcon, FolderInput, FolderPlus, ImagePlus, Images, Inbox, Loader2, MapPin, MoreHorizontal, Pencil, Play, RefreshCw, RotateCcw, Save, Star, Trash2, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { assetToRef, assetsToEnvironments, createFolder, deleteAssets, dismissGeneration, moveAssets, recreate, retryGeneration, saveAsset } from '../lib/actions';
import { formatCost } from '../lib/models';
import { invalidateGallery, keys, queryClient, useActive, useAssets, useFolders } from '../lib/queries';
import { errorText, rangeGap, setGridOrder, useStore } from '../lib/store';
import type { Asset, Folder, Generation } from '../lib/types';
import { Button, Empty, IconButton, Popover, Segmented, Spinner, useIsMobile, useLongPress } from './ui';
import { MoveMenu } from './MoveMenu';

const DRAG_TYPE = 'application/x-studio-assets';

function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Refresh the gallery and balances when running jobs finish. */
function useCompletionWatcher(ws: string | null, active: Generation[] | undefined) {
  const previous = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ws || !active) return;
    const running = new Set(active.filter(g => g.status !== 'failed').map(g => g.id));
    const finished = [...previous.current].some(id => !running.has(id));
    previous.current = running;
    if (finished) {
      invalidateGallery(ws);
      queryClient.invalidateQueries({ queryKey: keys.balances });
    }
  }, [ws, active]);
}

// ---------------------------------------------------------------- cards

function ActiveCard({ g }: { g: Generation }) {
  const ws = useStore(s => s.workspaceId)!;
  const set = useStore(s => s.set);
  const [retrying, setRetrying] = useState(false);
  const dismiss = (e: React.MouseEvent) => { e.stopPropagation(); dismissGeneration(g.id, ws); };
  const retry = async (e: React.MouseEvent) => { e.stopPropagation(); setRetrying(true); await retryGeneration(g.id, ws); setRetrying(false); };
  // Clicking the card (outside its buttons) opens the details popup.
  const open = () => set({ modal: { type: 'generation', id: g.id } });
  const openProps = {
    role: 'button', tabIndex: 0, onClick: open, title: 'Show details',
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
  };

  if (g.status === 'failed') {
    return (
      <div {...openProps} className="flex aspect-[3/4] cursor-pointer flex-col gap-1 overflow-hidden rounded-lg border border-danger/30 bg-danger/5 p-1.5 text-sm transition hover:border-danger/60 md:gap-1.5 md:rounded-xl md:p-2">
        <div className="flex items-center gap-1 text-[11px] font-medium text-danger md:text-xs"><AlertTriangle className="size-3.5 shrink-0" /> Failed</div>
        <div className="line-clamp-4 min-h-0 flex-1 break-words text-[10px] leading-snug text-muted md:line-clamp-6 md:text-[11px]" title={g.error || ''}>{g.error}</div>
        <div className="hidden truncate text-[10px] text-faint md:block">{g.modelName}</div>
        <div className="flex gap-1">
          <button className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-panel-3 text-[11px] font-medium hover:bg-white/12 disabled:opacity-50"
            disabled={retrying} onClick={retry} title="Retry: submit again with the same settings" aria-label="Retry">
            {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}<span className="hidden xl:inline">Retry</span>
          </button>
          <button className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-panel-3 text-[11px] font-medium hover:bg-white/12"
            onClick={e => { e.stopPropagation(); recreate(g.id); }} title="Recreate: load into the create box to edit" aria-label="Recreate">
            <RotateCcw className="size-3.5" /><span className="hidden xl:inline">Recreate</span>
          </button>
          <button className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-fg" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    );
  }
  return (
    <div {...openProps} className="shimmer relative flex aspect-[3/4] cursor-pointer flex-col justify-end overflow-hidden rounded-lg border border-line p-1.5 transition hover:border-line-strong md:rounded-xl md:p-2">
      <div className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] text-fg backdrop-blur md:text-[11px]"
        title={g.status === 'pending' ? 'Submitting' : g.status === 'queued' ? 'Queued' : g.status === 'saving' ? 'Saving' : 'Generating'}>
        {g.status === 'queued' || g.status === 'pending' ? <Clock className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
        <span className="hidden sm:inline">{g.status === 'pending' ? 'Submitting' : g.status === 'queued' ? 'Queued' : g.status === 'saving' ? 'Saving' : 'Generating'}</span>
      </div>
      <div className="truncate text-[10px] font-medium md:text-[11px]">{g.modelName}</div>
      <div className="hidden text-[10px] text-muted md:line-clamp-2">{g.prompt}</div>
      {g.estimatedCost != null && <div className="text-[10px] text-faint">{formatCost(g.estimatedCost, g.costUnit)}</div>}
    </div>
  );
}

const duration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Corner pill marking video results (photos stay unmarked). */
function VideoBadge({ asset }: { asset: Asset }) {
  if (asset.kind !== 'video') return null;
  return (
    <span title="Video" className="pointer-events-none absolute bottom-1 left-1 flex h-5 items-center gap-0.5 rounded-full bg-black/65 px-1 pr-1.5 text-[10px] font-semibold tabular-nums text-fg backdrop-blur transition md:bottom-1.5 md:left-1.5 md:group-hover:opacity-0">
      <Play className="size-2.5 fill-current" />{asset.duration ? duration(asset.duration) : 'Video'}
    </span>
  );
}

function AssetCard({ asset, onOpen }: { asset: Asset; onOpen: () => void }) {
  const { selecting, selected, toggleSelect, selectRangeTo, set } = useStore();
  // Desktop: hovering a video card plays a silent preview.
  const [hoverPlay, setHoverPlay] = useState(false);
  const canHover = asset.kind === 'video' && window.matchMedia('(hover: hover)').matches;
  const isSelected = selected.includes(asset.id);
  const { handlers, fired } = useLongPress(() => { set({ selecting: true }); toggleSelect(asset.id); });

  function click(e: React.MouseEvent) {
    if (fired.current) { fired.current = false; return; }
    if (selecting || e.shiftKey || e.metaKey || e.ctrlKey) {
      if (!selecting) set({ selecting: true });
      // Shift+click: everything between the last clicked result and this one.
      if (e.shiftKey) { e.preventDefault(); selectRangeTo(asset.id); }
      else toggleSelect(asset.id);
    } else onOpen();
  }

  function dragStart(e: React.DragEvent) {
    const ids = isSelected ? useStore.getState().selected : [asset.id];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  }

  return (
    <div
      className="card-cv group relative"
      onMouseEnter={canHover ? () => setHoverPlay(true) : undefined}
      onMouseLeave={canHover ? () => setHoverPlay(false) : undefined}
    >
      <button
        {...handlers}
        onClick={click}
        draggable
        onDragStart={dragStart}
        title={asset.seen ? undefined : 'New: not opened yet'}
        className={clsx(
          'relative block aspect-[3/4] w-full overflow-hidden rounded-lg bg-panel-2 outline-none transition select-none [-webkit-touch-callout:none] md:rounded-xl',
          isSelected ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg'
            : !asset.seen ? 'ring-[1.5px] ring-accent/70 focus-visible:ring-2' // not opened yet
            : 'focus-visible:ring-2 focus-visible:ring-accent/60',
        )}
      >
        {asset.thumbUrl ? (
          <img src={asset.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} className={clsx('size-full object-cover transition duration-300', !selecting && 'md:group-hover:scale-[1.03]', isSelected && 'scale-95 rounded-xl')} />
        ) : asset.kind === 'video' ? (
          <video src={`${asset.url}#t=0.5`} muted playsInline preload="metadata" className="size-full object-cover" />
        ) : null}
        {hoverPlay && !selecting && (
          <video src={asset.url} poster={asset.thumbUrl || undefined} autoPlay muted loop playsInline className="absolute inset-0 size-full object-cover" />
        )}
        <VideoBadge asset={asset} />
        {asset.exported && <span title="Saved to workspace folder" className="absolute right-1 top-1 rounded-md bg-black/60 p-0.5 backdrop-blur md:right-1.5 md:top-1.5"><Save className="size-3 text-accent" /></span>}
      </button>
      <button
        aria-label={isSelected ? 'Deselect' : 'Select'}
        onClick={e => {
          if (!selecting) set({ selecting: true });
          if (e.shiftKey) { e.preventDefault(); selectRangeTo(asset.id); } else toggleSelect(asset.id);
        }}
        className={clsx(
          'absolute left-1 top-1 flex size-6 items-center justify-center rounded-md border backdrop-blur transition md:left-1.5 md:top-1.5',
          isSelected ? 'border-accent bg-accent text-accent-fg' : 'border-white/40 bg-black/40 text-transparent',
          selecting || isSelected ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100',
        )}
      >
        <Check className="size-3.5" />
      </button>
      {!selecting && <CardActions asset={asset} />}
    </div>
  );
}

/** Quick actions: a row along the bottom on hover (desktop). Phones use the viewer's actions instead. */
function CardActions({ asset }: { asset: Asset }) {
  const action = 'flex size-7 items-center justify-center rounded-md text-white/90 transition hover:bg-white/15 hover:text-white [&>svg]:size-3.5';
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden justify-around rounded-b-xl bg-gradient-to-t from-black/80 to-transparent px-1 pb-1 pt-6 opacity-0 transition md:flex md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100">
      {asset.kind === 'image' && (
        <button className={action} aria-label="Use as reference" title="Use as reference" onClick={() => assetToRef(asset)}>
          <ImagePlus />
        </button>
      )}
      <button className={action} aria-label="Recreate" title="Recreate" onClick={() => recreate(asset.generationId, asset)}>
        <RotateCcw />
      </button>
      <button className={clsx(action, asset.exported && 'text-accent')} aria-label="Save" title={asset.exported ? 'Saved · save again' : 'Save to workspace folder'} onClick={() => saveAsset(asset)}>
        <Save />
      </button>
      <button className={clsx(action, 'hover:text-danger')} aria-label="Delete" title="Delete" onClick={() => deleteAssets(asset.workspaceId, [asset.id])}>
        <Trash2 />
      </button>
    </div>
  );
}

const GRID = 'grid grid-cols-4 gap-1 sm:grid-cols-5 sm:gap-1.5 md:grid-cols-6 md:gap-2 lg:grid-cols-8';

function AssetGrid({ folder, kind, showActive, emptyText }: { folder: string; kind: string; showActive?: boolean; emptyText: string }) {
  const ws = useStore(s => s.workspaceId);
  const set = useStore(s => s.set);
  const query = useAssets(ws, folder, kind);
  const active = useActive(ws);
  const items = useMemo(() => query.data?.pages.flatMap(p => p.items) || [], [query.data]);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
    }, { rootMargin: '1200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const activeHere = (active.data || []).filter(g =>
    (kind === 'all' || g.modality === kind) &&
    (folder === 'all' || (folder === 'unsorted' ? !g.folderId : g.folderId === folder)));
  const showActiveCards = showActive !== false && activeHere.length > 0;

  // One timeline in submission order: in-progress/failed cards sit between results by the time they
  // were submitted (results carry their job's submission time). Cards older than the loaded pages wait
  // until those pages load, so nothing appears out of place.
  const entries = useMemo(() => {
    const cutoff = query.hasNextPage && items.length ? Date.parse(items[items.length - 1].createdAt) : -Infinity;
    const cards = (showActiveCards ? activeHere : [])
      .filter(g => Date.parse(g.createdAt) >= cutoff)
      .map(g => ({ at: Date.parse(g.createdAt), card: g, asset: null as Asset | null, index: -1 }));
    const results = items.map((a, index) => ({ at: Date.parse(a.createdAt), card: null as Generation | null, asset: a, index }));
    return [...cards, ...results].sort((x, y) => y.at - x.at);
  }, [items, activeHere, showActiveCards, query.hasNextPage]);
  useEffect(() => { setGridOrder(entries.filter(e => e.asset).map(e => e.asset!.id)); }, [entries]);

  if (query.isLoading) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (query.isError) return <Empty title="Could not load" icon={<AlertTriangle className="size-8" />}>{errorText(query.error)}</Empty>;
  if (!items.length && !showActiveCards) return <Empty title="Nothing here yet" icon={<Images className="size-10" />}>{emptyText}</Empty>;

  return (
    <>
      <div className={GRID}>
        {entries.map(e => e.card
          ? <ActiveCard key={e.card.id} g={e.card} />
          : <AssetCard key={e.asset!.id} asset={e.asset!} onOpen={() => set({ viewer: { list: items, index: e.index } })} />)}
      </div>
      <div ref={sentinel} className="flex h-16 items-center justify-center">{query.isFetchingNextPage && <Spinner />}</div>
    </>
  );
}

// ---------------------------------------------------------------- folders

function useFolderDrop(folderId: string | null, name: string) {
  const ws = useStore(s => s.workspaceId)!;
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setOver(true); } },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        moveAssets(ws, JSON.parse(raw), folderId, name);
      },
    },
  };
}

function FolderMenu({ folder }: { folder: Folder }) {
  const ws = useStore(s => s.workspaceId)!;
  const { toast, set } = useStore();
  const [open, setOpen] = useState(false);
  async function rename() {
    setOpen(false);
    const name = prompt('Rename folder', folder.name)?.trim();
    if (!name || name === folder.name) return;
    try { await api.patch(`/api/folders/${folder.id}`, { name }); queryClient.invalidateQueries({ queryKey: keys.folders(ws) }); }
    catch (error) { toast(errorText(error), 'error'); }
  }
  async function remove() {
    setOpen(false);
    if (!confirm(`Delete folder "${folder.name}"? Its ${folder.count} item(s) move to Unsorted.`)) return;
    await api.del(`/api/folders/${folder.id}`);
    if (useStore.getState().folder === folder.id) set({ folder: null });
    if (useStore.getState().draft.folderId === folder.id) useStore.getState().patchDraft({ folderId: null });
    invalidateGallery(ws);
  }
  return (
    <Popover open={open} onOpenChange={setOpen} side="bottom" align="right" width="w-44" title={folder.name} trigger={
      <IconButton label="Folder options" className="size-8" onClick={e => { e.stopPropagation(); setOpen(!open); }}><MoreHorizontal className="size-4" /></IconButton>
    }>
      <button className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm hover:bg-white/6" onClick={rename}><Pencil className="size-4" /> Rename</button>
      <button className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm text-danger hover:bg-white/6" onClick={remove}><Trash2 className="size-4" /> Delete</button>
    </Popover>
  );
}

function FolderCard({ id, name, count, cover, updatedAt, folder }: { id: string; name: string; count: number; cover: string | null; updatedAt?: string; folder?: Folder }) {
  const set = useStore(s => s.set);
  const drop = useFolderDrop(id === 'unsorted' ? null : id, name);
  return (
    <div {...drop.props} className={clsx('card-cv group relative rounded-2xl border bg-panel p-2 transition', drop.over ? 'border-accent' : 'border-line hover:border-line-strong')}>
      <button onClick={() => set({ view: 'folders', folder: id })} className="block w-full text-left">
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-panel-2">
          {cover ? <img src={cover} alt="" loading="lazy" className="size-full object-cover" /> :
            <div className="flex size-full items-center justify-center text-faint">{id === 'unsorted' ? <Inbox className="size-8" /> : <FolderIcon className="size-8" />}</div>}
        </div>
        <div className="px-1 pb-0.5 pt-2">
          <div className="truncate pr-8 text-sm font-medium">{name}</div>
          <div className="text-xs text-muted">{count} item{count === 1 ? '' : 's'}{updatedAt && count ? ` · ${timeAgo(updatedAt)}` : ''}</div>
        </div>
      </button>
      {folder && <div className="absolute bottom-2 right-1"><FolderMenu folder={folder} /></div>}
    </div>
  );
}

async function promptNewFolder(ws: string) {
  const name = prompt('New folder name')?.trim();
  if (!name) return null;
  try { return await createFolder(ws, name); }
  catch (error) { useStore.getState().toast(errorText(error), 'error'); return null; }
}

function FolderGrid() {
  const ws = useStore(s => s.workspaceId);
  const { data, isLoading } = useFolders(ws);
  if (isLoading || !data) return <div className="flex justify-center py-20"><Spinner /></div>;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:gap-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      <button onClick={() => promptNewFolder(ws!)} className="flex aspect-[4/3.9] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-sm text-muted hover:border-accent/50 hover:text-fg">
        <FolderPlus className="size-6" /> New folder
      </button>
      <FolderCard id="unsorted" name="Unsorted" count={data.unsorted.count} cover={data.unsorted.coverUrl} updatedAt={data.unsorted.updatedAt} />
      {data.folders.map(f => <FolderCard key={f.id} id={f.id} name={f.name} count={f.count} cover={f.coverUrl} updatedAt={f.updatedAt} folder={f} />)}
    </div>
  );
}

function SidebarItem({ id, name, count, active, onClick, icon }: { id: string | null; name: string; count?: number; active: boolean; onClick: () => void; icon: React.ReactNode }) {
  const drop = useFolderDrop(id, name);
  return (
    <button
      {...(id !== 'all' ? drop.props : {})}
      onClick={onClick}
      className={clsx('flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition',
        active ? 'bg-white/10 text-fg' : 'text-muted hover:bg-white/5 hover:text-fg', drop.over && 'bg-accent/15 text-accent ring-1 ring-accent/50')}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {count !== undefined && <span className="text-xs tabular-nums text-faint">{count}</span>}
    </button>
  );
}

/** Desktop sidebar: quick navigation plus drag-and-drop targets for moving items. */
export function FolderSidebar() {
  const { workspaceId: ws, view, folder, set } = useStore();
  const { data } = useFolders(ws);
  return (
    <aside className="scrollbar-thin sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-56 shrink-0 overflow-y-auto border-r border-line p-3 lg:block">
      <SidebarItem id="all" name="Timeline" active={view === 'timeline'} onClick={() => set({ view: 'timeline', folder: null })} icon={<Clock className="size-4" />} />
      <SidebarItem id={null} name="All folders" active={view === 'folders' && !folder} onClick={() => set({ view: 'folders', folder: null })} icon={<FolderIcon className="size-4" />} />
      <div className="mb-1 mt-4 flex items-center justify-between px-2.5 text-xs font-medium uppercase tracking-wide text-faint">
        Folders
        <IconButton label="New folder" className="size-7" onClick={() => promptNewFolder(ws!)}><FolderPlus className="size-4" /></IconButton>
      </div>
      <SidebarItem id={null} name="Unsorted" count={data?.unsorted.count} active={view === 'folders' && folder === 'unsorted'} onClick={() => set({ view: 'folders', folder: 'unsorted' })} icon={<Inbox className="size-4" />} />
      {data?.folders.map(f => (
        <SidebarItem key={f.id} id={f.id} name={f.name} count={f.count} active={view === 'folders' && folder === f.id} onClick={() => set({ view: 'folders', folder: f.id })} icon={<FolderIcon className="size-4" />} />
      ))}
      <p className="mt-4 px-2.5 text-xs leading-relaxed text-faint">Tip: drag results onto a folder to move them.</p>
    </aside>
  );
}

// ---------------------------------------------------------------- selection

/** Selection actions: inline in the grid's header row on desktop (nothing shifts), a bottom bar on phones. */
function SelectionBar({ inline }: { inline?: boolean }) {
  const { selected, selecting, clearSelection, set, workspaceId, view, folder, kind, toast, fillRange } = useStore();
  const mobile = useIsMobile();
  const [allIds, setAllIds] = useState<string[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const [moving, setMoving] = useState(false);
  useEffect(() => setAllIds(null), [view, folder, kind, workspaceId]);
  if (!selecting || (inline ? mobile : !mobile)) return null;

  // Results stay in the timeline; their photos are filed in a reference library.
  async function toLibrary(to: 'model' | 'environments') {
    setMoving(true);
    try {
      const count = to === 'environments'
        ? (await assetsToEnvironments(selected)).length
        : (await api.post<unknown[]>('/api/refs/from-assets', { assetIds: selected, modelRef: true })).length;
      if (to === 'model') queryClient.invalidateQueries({ queryKey: keys.refs(workspaceId!) });
      toast(`Added ${count} photo${count === 1 ? '' : 's'} to ${to === 'model' ? 'Model refs' : 'Environments'}${count < selected.length ? ` (${selected.length - count} videos skipped)` : ''}`, 'ok');
      clearSelection();
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setMoving(false); }
  }
  const allSelected = allIds !== null && allIds.length > 0 && allIds.every(id => selected.includes(id));

  async function selectAll() {
    if (allSelected) { set({ selected: [] }); return; }
    setLoadingAll(true);
    try {
      const params = new URLSearchParams({ workspaceId: workspaceId!, folder: view === 'timeline' ? 'all' : folder || 'all', kind: kind === 'all' ? '' : kind });
      const ids = await api.get<string[]>(`/api/assets/ids?${params}`);
      setAllIds(ids);
      set({ selected: ids });
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setLoadingAll(false); }
  }

  const controls = (
    <>
      <IconButton label="Cancel selection" onClick={clearSelection}><X className="size-5" /></IconButton>
      <span className="shrink-0 text-sm font-medium tabular-nums">{selected.length} selected</span>
      <Button variant="ghost" loading={loadingAll} onClick={selectAll}>{allSelected ? 'Clear' : 'Select all'}</Button>
      {rangeGap(selected) && (
        <Button variant="ghost" onClick={fillRange} title="Select everything between the first and last selected (desktop: Shift+click)">Range</Button>
      )}
      {inline && <span className="hidden text-xs text-faint xl:inline">Shift+click selects a range</span>}
      <span className={inline ? 'w-2' : 'flex-1'} />
      <MoveMenu side={inline ? 'bottom' : 'top'} align={inline ? 'left' : 'left'} disabled={!selected.length} busy={moving} targets={[
          { key: 'folder', label: 'Folder…', icon: <FolderInput className="size-4" />, hint: 'Another folder of this workspace', onSelect: () => set({ modal: { type: 'move', assetIds: selected } }) },
          { key: 'model', label: 'Model refs', icon: <Star className="size-4" />, hint: 'Photos only; results stay in your timeline', onSelect: () => toLibrary('model') },
          { key: 'environments', label: 'Environments', icon: <MapPin className="size-4" />, hint: 'Photos only; shared by all your workspaces', onSelect: () => toLibrary('environments') },
      ]} />
      <Button variant="danger" disabled={!selected.length} onClick={() => deleteAssets(workspaceId!, selected)}><Trash2 className="size-4" /><span className="hidden sm:inline">Delete</span></Button>
    </>
  );
  if (inline) return <div className="flex min-w-0 items-center gap-1.5">{controls}</div>;
  return (
    <div className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel/95 backdrop-blur-xl">
      <div className="no-scrollbar flex h-16 items-center gap-2 overflow-x-auto px-3">{controls}</div>
    </div>
  );
}

// ---------------------------------------------------------------- main

export function Gallery() {
  const { workspaceId: ws, view, folder, kind, set, selecting } = useStore();
  const active = useActive(ws);
  const folders = useFolders(ws);
  useCompletionWatcher(ws, active.data);
  const folderName = folder === 'unsorted' ? 'Unsorted' : folders.data?.folders.find(f => f.id === folder)?.name;
  const openFolder = view === 'folders' && folder;

  useEffect(() => {
    // A folder that was deleted elsewhere: go back to the grid.
    if (view === 'folders' && folder && folder !== 'unsorted' && folders.data && !folderName) set({ folder: null });
  }, [view, folder, folders.data, folderName, set]);

  return (
    <div className="min-w-0 flex-1 px-2 pb-48 pt-3 md:px-5">
      {/* One line on desktop, so starting a selection never pushes the grid down. */}
      <div className="mb-3 flex min-h-10 flex-wrap items-center gap-2 md:flex-nowrap">
        <Segmented
          className={clsx('lg:hidden', selecting && 'md:hidden')}
          value={view}
          onChange={v => set({ view: v, folder: null })}
          options={[{ value: 'timeline', label: 'Timeline' }, { value: 'folders', label: 'Folders' }]}
        />
        {openFolder ? (
          <div className="flex min-w-0 items-center gap-1 text-sm">
            <button className="text-muted hover:text-fg" onClick={() => set({ folder: null })}>Folders</button>
            <span className="text-faint">/</span>
            <span className="truncate font-semibold">{folderName}</span>
          </div>
        ) : (
          <h1 className="hidden text-base font-semibold lg:block">{view === 'timeline' ? 'Timeline' : 'Folders'}</h1>
        )}
        <SelectionBar inline />
        <div className="ml-auto flex items-center gap-1">
          {(view === 'timeline' || openFolder) && (
            <>
              <Segmented value={kind} onChange={v => set({ kind: v })} options={[
                { value: 'all', label: 'All' },
                { value: 'image', label: <span className="flex items-center gap-1.5" title="Photos"><Images className="size-4" /><span className="hidden sm:inline md:hidden lg:inline">Photos</span></span> },
                { value: 'video', label: <span className="flex items-center gap-1.5" title="Videos"><Film className="size-4" /><span className="hidden sm:inline md:hidden lg:inline">Videos</span></span> },
              ]} />
              <IconButton label="Select" active={selecting} onClick={() => (selecting ? useStore.getState().clearSelection() : set({ selecting: true }))}>
                <CheckSquare className="size-5" />
              </IconButton>
            </>
          )}
        </div>
      </div>

      <SelectionBar />
      {view === 'timeline' && <AssetGrid folder="all" kind={kind} emptyText="Write a prompt below and hit Generate. Everything you create shows up here." />}
      {view === 'folders' && !folder && <FolderGrid />}
      {openFolder && <AssetGrid folder={folder} kind={kind} emptyText="Pick this folder in the create box, or move results here." />}
    </div>
  );
}
