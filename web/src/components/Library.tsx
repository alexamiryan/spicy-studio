import { clsx } from 'clsx';
import { AtSign, CheckSquare, Folder as FolderIcon, Loader2, Pencil, Plus, Sparkles, Star, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { addRefsToDraft, uploadRefs } from '../lib/actions';
import { useFileDrop, usePasteFiles } from '../lib/fileInput';
import { keys, queryClient, useAssets, useElements, useFolders, useRefs } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import type { Asset, Element, Ref } from '../lib/types';
import { AudioFace, MediaTile, Preview, useInfiniteSentinel, type Item } from './RefPicker';
import { Button, Empty, Field, IconButton, Modal, Segmented, Spinner, inputClass } from './ui';

/** Pick generated photos (by folder) and file them under Model refs. */
function AddFromGenerated({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const { workspaceId: ws, toast } = useStore();
  const [folder, setFolder] = useState('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const folders = useFolders(ws);
  const query = useAssets(open ? ws : null, folder, 'image');
  const items = useMemo(() => query.data?.pages.flatMap(p => p.items) || [], [query.data]);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setPicked([]); }, [open]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(e => { if (e[0].isIntersecting && query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, open]);

  const allPicked = items.length > 0 && items.every(a => picked.includes(a.id));
  async function add() {
    setBusy(true);
    try {
      await api.post('/api/refs/from-assets', { assetIds: picked, modelRef: true });
      queryClient.invalidateQueries({ queryKey: keys.refs(ws!) });
      toast(`Added ${picked.length} to Model refs`, 'ok');
      onAdded();
      onClose();
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} full title="Add generated photos to Model refs" footer={
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{picked.length ? `${picked.length} selected` : 'Tap photos to select'}</span>
        <Button variant="primary" className="ml-auto" disabled={!picked.length} loading={busy} onClick={add}>
          <Star className="size-4" />Add{picked.length ? ` ${picked.length}` : ''}
        </Button>
      </div>
    }>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
        <label className="flex h-10 items-center gap-2 rounded-xl border border-line bg-panel-2 px-3 text-sm">
          <FolderIcon className="size-4 text-muted" />
          <select className="bg-transparent outline-none" value={folder} onChange={e => setFolder(e.target.value)}>
            <option value="all">All folders</option>
            <option value="unsorted">Unsorted</option>
            {folders.data?.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        {items.length > 1 && (
          <Button variant="ghost" className="ml-auto" onClick={() => setPicked(allPicked ? [] : items.map(a => a.id))}>
            {allPicked ? 'Clear' : 'Select all'}
          </Button>
        )}
      </div>
      <div className="p-4">
        {query.isLoading ? <div className="flex justify-center py-16"><Spinner /></div> : !items.length ? (
          <Empty title="No generated photos here">Pick another folder.</Empty>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {items.map(a => {
              const index = picked.indexOf(a.id);
              return (
                <MediaTile key={a.id} item={{ id: a.id, thumbUrl: a.thumbUrl, url: a.url, kind: a.kind, name: a.modelName }}
                  selected={index >= 0} badge={index >= 0 ? index + 1 : undefined} saved={a.exported}
                  onClick={() => setPicked(p => (p.includes(a.id) ? p.filter(x => x !== a.id) : [...p, a.id]))} />
              );
            })}
          </div>
        )}
        <div ref={sentinel} className="flex h-10 items-center justify-center">{query.isFetchingNextPage && <Loader2 className="size-5 animate-spin text-muted" />}</div>
      </div>
    </Modal>
  );
}

function RefsTab() {
  const { workspaceId: ws, toast } = useStore();
  const [tab, setTab] = useState<'all' | 'model' | 'uploads'>('all');
  const query = useRefs(ws, tab);
  const items = useMemo(() => query.data?.pages.flatMap(p => p.items) || [], [query.data]);
  const [detail, setDetail] = useState<Ref | null>(null);
  const [addGenerated, setAddGenerated] = useState(false);
  // Multi-select mode: tiles toggle instead of opening the details bar.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [allIds, setAllIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const open = useStore(s => s.modal?.type === 'library');

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(e => { if (e[0].isIntersecting && query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  useEffect(() => { setSelected([]); setAllIds(null); setDetail(null); }, [tab]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: keys.refs(ws!) });
    queryClient.invalidateQueries({ queryKey: keys.elements(ws!) });
  };

  async function onFiles(files: File[] | FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try { await uploadRefs(ws!, files, tab === 'model'); toast(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`); }
    catch (error) { toast(errorText(error), 'error'); }
    finally { setUploading(false); if (input.current) input.current.value = ''; }
  }
  usePasteFiles(onFiles, open);
  const drop = useFileDrop(onFiles, open);

  async function patch(ref: Ref, body: Partial<{ name: string; isModelRef: boolean }>) {
    try {
      const updated = await api.patch<Ref>(`/api/refs/${ref.id}`, body);
      setDetail(updated);
      queryClient.invalidateQueries({ queryKey: keys.refs(ws!) });
    } catch (error) { toast(errorText(error), 'error'); }
  }

  async function remove(ref: Ref) {
    if (!confirm(`Delete "${ref.name}"? It is also removed from any element that uses it.`)) return;
    await api.del(`/api/refs/${ref.id}`);
    setDetail(null);
    refresh();
  }

  const allSelected = allIds !== null && allIds.length > 0 && allIds.every(id => selected.includes(id));
  async function selectAll() {
    if (allSelected) { setSelected([]); return; }
    try {
      const ids = await api.get<string[]>(`/api/refs/ids?workspaceId=${ws}&tab=${tab}`);
      setAllIds(ids);
      setSelected(ids);
    } catch (error) { toast(errorText(error), 'error'); }
  }

  async function bulk(action: 'delete' | 'model' | 'unmodel') {
    if (action === 'delete' && !confirm(`Delete ${selected.length} reference${selected.length === 1 ? '' : 's'}? They are also removed from any element that uses them.`)) return;
    setBusy(action);
    try {
      await api.post('/api/refs/bulk', { ids: selected, action });
      if (action === 'delete') setSelected([]);
      refresh();
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(null); }
  }

  async function useSelected() {
    setBusy('use');
    try {
      const refs = await api.get<Ref[]>(`/api/refs/by-ids?ids=${selected.join(',')}`);
      const order = new Map(selected.map((id, i) => [id, i]));
      refs.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
      let added = false;
      for (const kind of ['image', 'video', 'audio'] as const) {
        const group = refs.filter(r => r.kind === kind);
        if (group.length && addRefsToDraft(group)) added = true;
      }
      if (added) useStore.getState().set({ modal: null });
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(null); }
  }

  const exitSelect = () => { setSelecting(false); setSelected([]); };

  return (
    <div className="relative flex min-h-full flex-col" {...drop.props}>
      {drop.over && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/10 font-medium text-accent">
          Drop to upload{tab === 'model' ? ' as model refs' : ''}
        </div>
      )}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
        <Segmented value={tab} onChange={v => setTab(v)} options={[
          { value: 'all', label: 'All' }, { value: 'model', label: 'Model refs' }, { value: 'uploads', label: 'Uploads' },
        ]} />
        <input ref={input} type="file" multiple accept="image/*,video/*,audio/*" className="hidden" onChange={e => onFiles(e.target.files)} />
        <div className="ml-auto flex items-center gap-2">
          <Button variant={selecting ? 'subtle' : 'ghost'} onClick={() => (selecting ? exitSelect() : (setSelecting(true), setDetail(null)))}>
            <CheckSquare className="size-4" />{selecting ? 'Done' : 'Select'}
          </Button>
          <Button variant="outline" onClick={() => setAddGenerated(true)} title="Add generated photos to Model refs">
            <Sparkles className="size-4" /><span className="hidden sm:inline">Add from generated</span><span className="sm:hidden">Generated</span>
          </Button>
          <Button variant="outline" onClick={() => input.current?.click()} loading={uploading}>
            {!uploading && <Upload className="size-4" />} Upload{tab === 'model' ? ' model refs' : ''}
          </Button>
        </div>
      </div>
      <AddFromGenerated open={addGenerated} onClose={() => setAddGenerated(false)} onAdded={() => setTab('model')} />
      {selecting && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel-2/60 px-4 py-2.5">
          <span className="min-w-20 text-sm font-medium">{selected.length} selected</span>
          <Button size="sm" variant="ghost" onClick={selectAll}>{allSelected ? 'Clear' : 'Select all'}</Button>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button size="sm" disabled={!selected.length} loading={busy === 'use'} onClick={useSelected}>Use</Button>
            <Button size="sm" disabled={!selected.length} loading={busy === 'model'} onClick={() => bulk('model')}><Star className="size-4" />Model ref</Button>
            <Button size="sm" disabled={!selected.length} loading={busy === 'unmodel'} onClick={() => bulk('unmodel')}>Unmark</Button>
            <Button size="sm" variant="danger" disabled={!selected.length} loading={busy === 'delete'} onClick={() => bulk('delete')}><Trash2 className="size-4" />Delete</Button>
          </div>
        </div>
      )}
      {detail && !selecting && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel-2/60 px-4 py-3">
          {detail.kind === 'audio'
            ? <div className="size-12 shrink-0 overflow-hidden rounded-lg"><AudioFace name="" size="sm" /></div>
            : <img src={detail.thumbUrl || ''} alt="" className="size-12 rounded-lg object-cover" />}
          {detail.kind === 'audio' && <audio key={detail.id} src={detail.url} controls className="h-10 w-full sm:w-64" />}
          <input className={clsx(inputClass, 'h-10 w-auto min-w-0 flex-1')} defaultValue={detail.name} key={detail.id}
            onBlur={e => e.target.value.trim() && e.target.value !== detail.name && patch(detail, { name: e.target.value })} />
          <Button size="sm" variant={detail.isModelRef ? 'primary' : 'outline'} onClick={() => patch(detail, { isModelRef: !detail.isModelRef })}>
            <Star className={clsx('size-4', detail.isModelRef && 'fill-current')} /> Model ref
          </Button>
          <Button size="sm" onClick={() => { if (addRefsToDraft([detail])) useStore.getState().set({ modal: null }); }}>Use</Button>
          <IconButton label="Delete reference" className="size-9 text-danger" onClick={() => remove(detail)}><Trash2 className="size-4" /></IconButton>
          <IconButton label="Close" className="size-9" onClick={() => setDetail(null)}><X className="size-4" /></IconButton>
        </div>
      )}
      <div className="flex-1 p-4">
        {query.isLoading ? <div className="flex justify-center py-16"><Spinner /></div> : !items.length ? (
          <Empty title={tab === 'model' ? 'No model references yet' : 'No references yet'}>
            {tab === 'model' ? 'Model refs are your influencer\'s canonical face and body shots. Upload them once and reuse them everywhere.' : 'Upload, drag files here, or paste an image (Ctrl+V).'}
          </Empty>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7">
            {items.map(r => {
              const index = selected.indexOf(r.id);
              return (
                <div key={r.id} className="relative">
                  <MediaTile item={r} selected={selecting ? index >= 0 : detail?.id === r.id} badge={selecting && index >= 0 ? index + 1 : undefined}
                    onClick={() => (selecting ? setSelected(sel => (sel.includes(r.id) ? sel.filter(x => x !== r.id) : [...sel, r.id])) : setDetail(r))} />
                  {r.isModelRef && <Star className="pointer-events-none absolute left-1.5 top-1.5 size-4 fill-accent text-accent drop-shadow" />}
                </div>
              );
            })}
          </div>
        )}
        <div ref={sentinel} className="flex h-10 items-center justify-center">{query.isFetchingNextPage && <Loader2 className="size-5 animate-spin text-muted" />}</div>
      </div>
    </div>
  );
}

const toItem = {
  ref: (r: Ref): Item => ({ id: r.id, thumbUrl: r.thumbUrl, url: r.url, kind: r.kind, name: r.name, ref: r }),
  asset: (a: Asset): Item => ({ id: a.id, thumbUrl: a.thumbUrl, url: a.url, kind: a.kind, name: a.modelName, asset: a }),
};
/** Media files are content-addressed, so the same photo has the same URL whether it's a result, upload or model ref. */
const sameMedia = (a: Item, b: Item) => a.url.split('?')[0] === b.url.split('?')[0];

/** Create or edit an element: pick its photos from generated results, model refs or uploads (or upload new ones). */
function ElementEditor({ element, onDone }: { element: Element | null; onDone: () => void }) {
  const { workspaceId: ws, toast } = useStore();
  const [name, setName] = useState(element?.name || '');
  const [description, setDescription] = useState(element?.description || '');
  const [picked, setPicked] = useState<Item[]>(() => (element?.refs || []).map(toItem.ref));
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'generated' | 'model' | 'uploads'>('generated');
  const [folder, setFolder] = useState('all');
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<Item | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const folders = useFolders(ws);
  const assets = useAssets(tab === 'generated' ? ws : null, folder, 'image');
  const refs = useRefs(tab !== 'generated' ? ws : null, tab === 'model' ? 'model' : 'uploads', 'image');
  const active = tab === 'generated' ? assets : refs;
  const sentinel = useInfiniteSentinel(active);
  const items: Item[] = useMemo(() => tab === 'generated'
    ? (assets.data?.pages.flatMap(p => p.items) || []).map(toItem.asset)
    : (refs.data?.pages.flatMap(p => p.items) || []).map(toItem.ref),
  [tab, assets.data, refs.data]);

  const indexOf = (item: Item) => picked.findIndex(p => sameMedia(p, item));
  const toggle = (item: Item) => setPicked(p => (p.some(x => sameMedia(x, item)) ? p.filter(x => !sameMedia(x, item)) : [...p, item]));
  const allPicked = items.length > 0 && items.every(i => indexOf(i) >= 0);
  const selectAll = () => setPicked(p => (allPicked
    ? p.filter(x => !items.some(i => sameMedia(i, x)))
    : [...p, ...items.filter(i => !p.some(x => sameMedia(x, i)))]));

  async function onFiles(files: File[] | FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      const uploaded = await uploadRefs(ws!, files, tab === 'model');
      const images = uploaded.filter(r => r.kind === 'image').map(toItem.ref);
      setPicked(p => [...p, ...images.filter(i => !p.some(x => sameMedia(x, i)))]);
      if (tab === 'generated') setTab('uploads');
      toast(`Uploaded and added ${images.length}`, 'ok');
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  usePasteFiles(onFiles, true);
  const drop = useFileDrop(onFiles, true);

  async function save() {
    setBusy(true);
    try {
      // Generated results become references (reusing one if it was turned into a ref before).
      const fromAssets = picked.filter(i => !i.ref && i.asset).map(i => i.asset!.id);
      const created = fromAssets.length ? await api.post<Ref[]>('/api/refs/from-assets', { assetIds: fromAssets }) : [];
      const refIds = picked.map(i => i.ref?.id || created[fromAssets.indexOf(i.asset!.id)].id);
      const body = { workspaceId: ws, name: name.trim(), description: description.trim(), refIds: [...new Set(refIds)] };
      await (element ? api.patch(`/api/elements/${element.id}`, body) : api.post('/api/elements', body));
      queryClient.invalidateQueries({ queryKey: keys.elements(ws!) });
      queryClient.invalidateQueries({ queryKey: keys.refs(ws!) });
      toast(element ? `Saved @${body.name}` : `Created @${body.name}`, 'ok');
      onDone();
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="relative flex min-h-full flex-col" {...drop.props}>
      {drop.over && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/10 font-medium text-accent">
          Drop to upload and add{tab === 'model' ? ' as model refs' : ''}
        </div>
      )}
      <div className="space-y-3 p-4 pb-3">
        <Field label="Name" hint="Mention it in prompts as @name. Letters, numbers, - and _ only.">
          <div className="relative">
            <AtSign className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-accent" />
            <input className={clsx(inputClass, 'pl-9')} value={name} onChange={e => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} placeholder="Mia" autoFocus={!element} />
          </div>
        </Field>
        <Field label="Description" hint="Optional. One line on who or what this is. Sent along with the photos to models that take elements themselves (Kling O3, Higgsfield Kling 3.0, Seedance 2.0, Seedream…).">
          <input className={inputClass} value={description} maxLength={500} onChange={e => setDescription(e.target.value)} placeholder="e.g. Young woman with long dark wavy hair and green eyes" />
        </Field>
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="font-medium">In {name ? `@${name}` : 'this element'}</span>
            <span className="text-faint">{picked.length} photo{picked.length === 1 ? '' : 's'} · attached in this order</span>
            {picked.length > 0 && <button className="ml-auto text-muted hover:text-fg" onClick={() => setPicked([])}>Clear</button>}
          </div>
          {picked.length ? (
            <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
              {picked.map((item, i) => (
                <div key={item.url} className="relative size-20 shrink-0">
                  <button onClick={() => setPreview(item)} className="block size-full overflow-hidden rounded-xl bg-panel-2" aria-label={`Preview ${item.name}`}>
                    {item.thumbUrl && <img src={item.thumbUrl} alt="" className="size-full object-cover" />}
                  </button>
                  <span className="pointer-events-none absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-accent-fg">{i + 1}</span>
                  <button aria-label="Remove" onClick={() => toggle(item)}
                    className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-black/70 text-fg backdrop-blur hover:bg-danger"><X className="size-3.5" /></button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-sm text-faint">
              Pick photos below, or upload / drop / paste new ones.
            </div>
          )}
        </div>
      </div>

      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-y border-line bg-panel px-4 py-3">
        <Segmented value={tab} onChange={setTab} options={[
          { value: 'generated', label: 'Generated' }, { value: 'model', label: 'Model refs' }, { value: 'uploads', label: 'Uploads' },
        ]} />
        {tab === 'generated' && (
          <label className="flex h-10 items-center gap-2 rounded-xl border border-line bg-panel-2 px-3 text-sm">
            <FolderIcon className="size-4 text-muted" />
            <select className="max-w-36 bg-transparent outline-none" value={folder} onChange={e => setFolder(e.target.value)}>
              <option value="all">All folders</option>
              <option value="unsorted">Unsorted</option>
              {folders.data?.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          {items.length > 1 && <Button variant="ghost" onClick={selectAll}>{allPicked ? 'Clear' : 'Select all'}</Button>}
          <input ref={fileInput} type="file" multiple accept="image/*" className="hidden" onChange={e => onFiles(e.target.files)} />
          <Button variant="outline" onClick={() => fileInput.current?.click()} loading={uploading} title={tab === 'model' ? 'Upload as model refs' : 'Upload'}>
            {!uploading && <Upload className="size-4" />}<span className="hidden sm:inline">Upload</span>
          </Button>
        </div>
      </div>

      <div className="flex-1 p-4">
        {active.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : !items.length ? (
          <Empty title={tab === 'generated' ? 'No generated photos here' : tab === 'model' ? 'No model refs yet' : 'No uploads yet'}>
            {tab === 'generated' ? 'Pick another folder.' : 'Upload, drag files here, or paste an image (Ctrl+V).'}
          </Empty>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7">
            {items.map(item => {
              const index = indexOf(item);
              return <MediaTile key={item.id} item={item} selected={index >= 0} badge={index >= 0 ? index + 1 : undefined}
                saved={item.asset?.exported} onClick={() => toggle(item)} />;
            })}
          </div>
        )}
        <div ref={sentinel} className="flex h-10 items-center justify-center">{active.isFetchingNextPage && <Loader2 className="size-5 animate-spin text-muted" />}</div>
      </div>

      <div className="pb-safe sticky bottom-0 z-20 flex items-center gap-2 border-t border-line bg-panel px-4 py-3">
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <span className="text-sm text-muted">{picked.length} selected</span>
        <Button variant="primary" className="ml-auto" loading={busy} disabled={!name || !picked.length} onClick={save}>{element ? 'Save element' : 'Create element'}</Button>
      </div>
      {preview && <Preview item={preview} action={{ label: 'Remove from element', onClick: () => toggle(preview) }} onClose={() => setPreview(null)} />}
    </div>
  );
}

function ElementsTab() {
  const { workspaceId: ws } = useStore();
  const { data = [], isLoading } = useElements(ws);
  const [editing, setEditing] = useState<Element | null | 'new'>(null);

  async function remove(e: Element) {
    if (!confirm(`Delete @${e.name}? Its references stay in your library.`)) return;
    await api.del(`/api/elements/${e.id}`);
    queryClient.invalidateQueries({ queryKey: keys.elements(ws!) });
  }

  if (editing) return <ElementEditor element={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />;
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-start gap-3 rounded-2xl bg-panel-2 p-3 text-sm text-muted">
        <AtSign className="mt-0.5 size-5 shrink-0 text-accent" />
        <p>Elements group references under a name. Type <span className="font-medium text-fg">@name</span> in a prompt and all its images are attached to the generation automatically.</p>
      </div>
      <Button variant="outline" className="w-full" onClick={() => setEditing('new')}><Plus className="size-4" /> New element</Button>
      {isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : data.map(e => (
        <div key={e.id} className="flex items-center gap-3 rounded-2xl border border-line p-2.5">
          <div className="flex -space-x-3">
            {e.refs.slice(0, 4).map(r => <img key={r.id} src={r.thumbUrl || ''} alt="" className="size-11 rounded-lg border-2 border-panel object-cover" />)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-accent">@{e.name}</div>
            <div className="text-xs text-faint">{e.refs.length} reference{e.refs.length === 1 ? '' : 's'}</div>
          </div>
          <IconButton label="Edit element" onClick={() => setEditing(e)}><Pencil className="size-4" /></IconButton>
          <IconButton label="Delete element" className="text-danger" onClick={() => remove(e)}><Trash2 className="size-4" /></IconButton>
        </div>
      ))}
    </div>
  );
}

export function Library() {
  const { modal, set } = useStore();
  const open = modal?.type === 'library';
  const tab = open ? modal.tab || 'refs' : 'refs';
  return (
    <Modal open={open} onClose={() => set({ modal: null })} full title={
      <Segmented value={tab} onChange={t => set({ modal: { type: 'library', tab: t } })} options={[
        { value: 'refs', label: 'References' }, { value: 'elements', label: 'Elements' },
      ]} />
    }>
      {tab === 'refs' ? <RefsTab /> : <ElementsTab />}
    </Modal>
  );
}
