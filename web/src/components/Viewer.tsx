import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Check, ChevronLeft, MapPin, Clapperboard, Star, ChevronRight, Copy, Download, Folder as FolderIcon, FolderInput, ImagePlus, Loader2, RotateCcw, Save, Trash2, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { addToEnvironments, addToModelRefs, animateAsset, assetToRef, deleteAssets, downloadAsset, markSeen, recreate, saveAsset } from '../lib/actions';
import { formatCost } from '../lib/models';
import { saveFolderLabel, useMySettings, useWorkspaces } from '../lib/queries';
import { useStore } from '../lib/store';
import type { Asset, GenerationDetail, Ref } from '../lib/types';
import { AudioFace, Preview } from './RefPicker';
import { MoveMenu } from './MoveMenu';
import { MobileViewer } from './MobileViewer';
import { IconButton, Spinner, useIsMobile } from './ui';

export function Info({ generationId }: { generationId: string }) {
  const { data: g, isLoading } = useQuery({
    queryKey: ['generation', generationId],
    queryFn: () => api.get<GenerationDetail>(`/api/generations/${generationId}`),
    staleTime: 60_000,
  });
  const toast = useStore(s => s.toast);
  const [zoomed, setZoomed] = useState<Ref | null>(null);
  if (isLoading || !g) return <div className="flex justify-center py-8"><Spinner /></div>;
  const settings = Object.entries(g.settings || {});
  return (
    <div className="space-y-5">
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-faint">Prompt</h3>
          {g.prompt && (
            <button className="flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => { navigator.clipboard?.writeText(g.prompt); toast('Prompt copied'); }}>
              <Copy className="size-3.5" /> Copy
            </button>
          )}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{g.prompt || <span className="text-faint">No prompt</span>}</p>
      </section>
      {g.refs.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-faint">References</h3>
          <div className="flex flex-wrap gap-1.5">
            {Object.values(g.refSlots).flat().map((id, i) => {
              const ref = g.refs.find(r => r.id === id);
              return ref ? (
                <button key={`${id}-${i}`} onClick={() => setZoomed(ref)} title={`${ref.name} (click to zoom)`}
                  className="relative size-16 cursor-zoom-in overflow-hidden rounded-lg bg-panel-2 ring-accent/60 transition hover:ring-2">
                  {ref.kind === 'audio' ? <AudioFace name={ref.name} size="sm" /> : ref.thumbUrl && <img src={ref.thumbUrl} alt="" className="size-full object-cover" />}
                  <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[10px] text-accent">{i + 1}</span>
                </button>
              ) : null;
            })}
          </div>
        </section>
      )}
      {zoomed && <Preview item={zoomed} onClose={() => setZoomed(null)} />}
      <section className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div><div className="text-xs text-faint">Model</div><div className="truncate">{g.modelName}</div></div>
        <div><div className="text-xs text-faint">Provider</div><div className="capitalize">{({ spicyapi: 'SpicyAPI', poyo: 'PoYo', higgsfield: 'Higgsfield' } as Record<string, string>)[g.providerId] || g.providerId}</div></div>
        {settings.map(([k, v]) => (
          <div key={k}><div className="truncate text-xs text-faint">{k.replace(/_/g, ' ')}</div><div className="truncate">{String(v)}</div></div>
        ))}
        {g.status !== 'failed' && (g.cost ?? g.estimatedCost) != null && <div><div className="text-xs text-faint">Cost</div><div>{formatCost(g.cost ?? g.estimatedCost, g.costUnit)}</div></div>}
        <div><div className="text-xs text-faint">Folder</div><div className="flex items-center gap-1 truncate"><FolderIcon className="size-3.5 text-muted" />{g.folder?.name || 'Unsorted'}</div></div>
        <div className="col-span-2"><div className="text-xs text-faint">Created</div><div>{new Date(g.createdAt).toLocaleString()}</div></div>
      </section>
    </div>
  );
}

/** Where "Save" copies a result, e.g. "\\\\192.168.1.10\\ai\\Pictures\\Mia\\images". */
export function useSaveTarget(asset: Asset | null) {
  const { data: workspaces } = useWorkspaces();
  const { data: settings } = useMySettings();
  const ws = workspaces?.find(w => w.id === asset?.workspaceId);
  if (!asset || !ws) return '';
  return saveFolderLabel(settings?.saveLabel, asset.kind === 'video' ? ws.videoExportDir : ws.imageExportDir) || 'No save location yet (Settings → Save location)';
}

const Kbd = ({ children }: { children: string }) => (
  <kbd className="ml-1 hidden rounded border border-current/30 px-1 font-sans text-[10px] leading-4 opacity-60 md:inline">{children}</kbd>
);

function SaveButton({ asset }: { asset: Asset }) {
  const [saving, setSaving] = useState(false);
  const target = useSaveTarget(asset);
  const save = async () => { if (saving) return; setSaving(true); await saveAsset(asset); setSaving(false); };
  const saved = asset.exported;
  return (
    <div className="space-y-1.5">
      <button
        onClick={save}
        disabled={saving}
        data-save-button
        className={clsx(
          'flex h-14 w-full items-center justify-center gap-2.5 rounded-2xl text-base font-semibold transition active:scale-[0.99] disabled:opacity-70',
          saved ? 'border border-accent/40 bg-accent/10 text-accent hover:bg-accent/15' : 'bg-accent text-accent-fg hover:brightness-110',
        )}
      >
        {saving ? <Loader2 className="size-5 animate-spin" /> : saved ? <Check className="size-5" /> : <Save className="size-5" />}
        {saving ? 'Saving…' : saved ? 'Saved · save again' : 'Save'}
        {!saving && <Kbd>S</Kbd>}
      </button>
      {target && <div className="truncate text-center text-xs text-faint" title={target}>to {target}</div>}
    </div>
  );
}

function SecondaryAction({ icon, label, kbd, ...props }: { icon: React.ReactNode; label: string; kbd?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} title={props.title || (kbd ? `${label} (${kbd})` : label)}
      className="flex h-14 w-full min-w-0 flex-col items-center justify-center gap-1 rounded-xl bg-panel-3 px-0.5 text-[11px] font-medium tracking-tight text-muted transition hover:bg-white/12 hover:text-fg disabled:opacity-40 disabled:hover:bg-panel-3">
      {icon}<span className="max-w-full truncate">{label}</span>
    </button>
  );
}

function DesktopViewer() {
  const { viewer, set, workspaceId } = useStore();
  const touch = useRef<{ x: number; y: number } | null>(null);
  const asset = viewer ? viewer.list[viewer.index] : null;

  const go = (delta: number) => {
    const v = useStore.getState().viewer;
    if (!v) return;
    const index = v.index + delta;
    if (index >= 0 && index < v.list.length) set({ viewer: { ...v, index } });
  };

  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || useStore.getState().modal) return;
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'Escape') set({ viewer: null });
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const v = useStore.getState().viewer;
      const current = v?.list[v.index];
      if (!current) return;
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); document.querySelector<HTMLButtonElement>('[data-save-button]')?.click(); }
      if (e.key === 'r' || e.key === 'R') recreate(current.generationId, current);
      if ((e.key === 'a' || e.key === 'A') && current.kind === 'image') animateAsset(current);
      if (e.key === 'Delete') deleteAssets(current.workspaceId, [current.id]);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [Boolean(viewer)]);

  useEffect(() => { if (asset) markSeen(asset); }, [asset?.id]);

  if (!viewer || !asset) return null;

  return createPortal(
    <div className="fade-in fixed inset-0 z-40 flex flex-col bg-black md:flex-row">
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onTouchStart={e => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
        onTouchEnd={e => {
          if (!touch.current) return;
          const dx = e.changedTouches[0].clientX - touch.current.x;
          const dy = e.changedTouches[0].clientY - touch.current.y;
          touch.current = null;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
          else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) set({ viewer: null });
        }}
      >
        {asset.kind === 'video' ? (
          <video key={asset.id} src={asset.url} poster={asset.thumbUrl || undefined} controls autoPlay loop playsInline className="max-h-full max-w-full" />
        ) : (
          <img key={asset.id} src={asset.url} alt={asset.prompt} className="max-h-full max-w-full select-none object-contain" draggable={false} />
        )}
        {/* Phones: close sits top-right over the image (the side panel is below). */}
        <div className="pt-safe absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent p-2 md:hidden">
          <span className="rounded-lg bg-black/40 px-2 py-1 text-xs text-muted backdrop-blur">{viewer.index + 1} / {viewer.list.length}</span>
          <IconButton label="Close" className="bg-black/40 text-fg backdrop-blur" onClick={() => set({ viewer: null })}><X className="size-5" /></IconButton>
        </div>
        <button aria-label="Previous" disabled={viewer.index === 0} onClick={() => go(-1)}
          className="absolute left-3 top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-fg backdrop-blur transition hover:bg-black/70 disabled:opacity-0 md:flex">
          <ChevronLeft className="size-6" />
        </button>
        <button aria-label="Next" disabled={viewer.index === viewer.list.length - 1} onClick={() => go(1)}
          className="absolute right-3 top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-fg backdrop-blur transition hover:bg-black/70 disabled:opacity-0 md:flex">
          <ChevronRight className="size-6" />
        </button>
      </div>
      <aside className="pb-safe flex max-h-[45dvh] w-full shrink-0 flex-col border-t border-line bg-panel md:max-h-none md:w-96 md:border-l md:border-t-0">
        {/* Desktop: close in the top-right corner, above the actions. */}
        <div className="hidden items-center justify-between px-3 pb-1 pt-3 md:flex">
          <span className="text-xs text-muted">{viewer.index + 1} / {viewer.list.length}</span>
          <IconButton label="Close" onClick={() => set({ viewer: null })}><X className="size-5" /></IconButton>
        </div>
        <div className="space-y-2 border-b border-line p-3 md:pt-2">
          <SaveButton asset={asset} />
          <div className="flex gap-1.5">
            <div className={clsx('grid min-w-0 flex-1 gap-1.5', asset.kind === 'image' ? 'grid-cols-5' : 'grid-cols-4')}>
              {asset.kind === 'image' && (
                <SecondaryAction icon={<Clapperboard className="size-4" />} label="Animate" kbd="A" onClick={() => animateAsset(asset)}
                  title="Animate: use as start frame with your last video settings and references (A)" />
              )}
              <SecondaryAction icon={<RotateCcw className="size-4" />} label="Recreate" kbd="R" onClick={() => recreate(asset.generationId, asset)} />
              <SecondaryAction icon={<ImagePlus className="size-4" />} label="As ref" onClick={() => assetToRef(asset)} disabled={asset.kind !== 'image'} title="Use as reference in the create box" />
              <MoveMenu align="right" targets={[
                { key: 'folder', label: 'Folder…', icon: <FolderInput className="size-4" />, hint: 'Another folder of this workspace', onSelect: () => set({ modal: { type: 'move', assetIds: [asset.id] } }) },
                ...(asset.kind === 'image' ? [
                  { key: 'model', label: 'Model refs', icon: <Star className="size-4" />, hint: 'The result stays in your timeline', onSelect: () => addToModelRefs(asset) },
                  { key: 'environments', label: 'Environments', icon: <MapPin className="size-4" />, hint: 'Shared by all your workspaces', onSelect: () => addToEnvironments(asset) },
                ] : []),
              ]} trigger={toggle => <SecondaryAction icon={<FolderInput className="size-4" />} label="Move to" onClick={toggle} title="Move to a folder, Model refs or Environments" />} />
              <SecondaryAction icon={<Download className="size-4" />} label="Download" onClick={() => downloadAsset(asset)} title="Download to this device" />
            </div>
            <button
              aria-label="Delete" title="Delete (Del)" onClick={() => deleteAssets(workspaceId!, [asset.id])}
              className="flex w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger transition hover:bg-danger/20"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
          <Info generationId={asset.generationId} />
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/** Phones get the Photos-style gesture viewer; larger screens the side-panel viewer. */
export function Viewer() {
  const mobile = useIsMobile();
  return mobile ? <MobileViewer /> : <DesktopViewer />;
}
