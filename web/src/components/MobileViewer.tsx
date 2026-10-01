import { clsx } from 'clsx';
import {
  Check, ChevronUp, Clapperboard, Star, Download, FolderInput, ImagePlus, Info as InfoIcon, Loader2, Pause, Play, RotateCcw, Save, Trash2, Volume2, VolumeX, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addToModelRefs, animateAsset, assetToRef, deleteAssets, downloadAsset, markSeen, recreate, saveAsset } from '../lib/actions';
import { useStore } from '../lib/store';
import type { Asset } from '../lib/types';
import { Info, useSaveTarget } from './Viewer';

/*
 * Photos-style fullscreen viewer for phones:
 * tap = show/hide controls · double-tap / pinch = zoom · drag when zoomed = pan
 * swipe left/right = next/previous · swipe down = close · swipe up = details
 */

type Mode = 'idle' | 'undecided' | 'pinch' | 'pan' | 'swipeX' | 'swipeY';
interface Zoom { s: number; x: number; y: number }

const MAX_ZOOM = 5;
const SWIPE_X = 70;   // px to go to the next/previous item
const SWIPE_DOWN = 110; // px to close
const SWIPE_UP = 70;  // px to open details
const TAP_MS = 280;

let rememberMuted = true; // autoplay needs muted; keep the user's choice while the app is open

const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const mid = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

function clampPan(z: Zoom): Zoom {
  const maxX = ((z.s - 1) * window.innerWidth) / 2;
  const maxY = ((z.s - 1) * window.innerHeight) / 2;
  return { s: z.s, x: Math.max(-maxX, Math.min(maxX, z.x)), y: Math.max(-maxY, Math.min(maxY, z.y)) };
}

function VideoControls({ video }: { video: HTMLVideoElement | null }) {
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(rememberMuted);
  const [time, setTime] = useState({ t: 0, d: 0 });
  useEffect(() => {
    if (!video) return;
    const update = () => { setPlaying(!video.paused); setTime({ t: video.currentTime, d: video.duration || 0 }); setMuted(video.muted); };
    const events = ['play', 'pause', 'timeupdate', 'loadedmetadata', 'volumechange'];
    events.forEach(ev => video.addEventListener(ev, update));
    update();
    return () => events.forEach(ev => video.removeEventListener(ev, update));
  }, [video]);
  if (!video) return null;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <div className="flex items-center gap-3 px-4 pb-2">
      <button aria-label={playing ? 'Pause' : 'Play'} onClick={() => (video.paused ? video.play() : video.pause())} className="flex size-9 items-center justify-center rounded-full bg-white/15">
        {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
      </button>
      <span className="w-9 text-right text-[11px] tabular-nums text-white/80">{fmt(time.t)}</span>
      <input
        type="range" min={0} max={time.d || 0} step={0.01} value={time.t} aria-label="Seek"
        onChange={e => { video.currentTime = Number(e.target.value); }}
        className="h-1 flex-1 accent-white"
      />
      <span className="w-9 text-[11px] tabular-nums text-white/80">{fmt(time.d)}</span>
      <button aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => { video.muted = !video.muted; rememberMuted = video.muted; }} className="flex size-9 items-center justify-center rounded-full bg-white/15">
        {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
    </div>
  );
}

function ActionBar({ asset, onInfo }: { asset: Asset; onInfo: () => void }) {
  const { set, workspaceId } = useStore();
  const [saving, setSaving] = useState(false);
  const target = useSaveTarget(asset);
  const save = async () => { if (saving) return; setSaving(true); await saveAsset(asset); setSaving(false); };
  const action = 'flex min-w-0 flex-1 flex-col items-center gap-1 py-1.5 text-[10px] font-medium text-white/85 active:text-white disabled:opacity-40';
  return (
    <div className="space-y-2 px-3">
      <button
        onClick={save} disabled={saving}
        className={clsx('flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold backdrop-blur-md transition active:scale-[0.98]',
          asset.exported ? 'border border-accent/50 bg-black/40 text-accent' : 'bg-accent text-accent-fg')}
      >
        {saving ? <Loader2 className="size-5 animate-spin" /> : asset.exported ? <Check className="size-5" /> : <Save className="size-5" />}
        {saving ? 'Saving…' : asset.exported ? 'Saved · save again' : 'Save'}
      </button>
      {target && <div className="-mt-1 truncate text-center text-[10px] text-white/50">to {target}</div>}
      <div className="flex items-stretch justify-between">
        <button className={action} onClick={() => recreate(asset.generationId, asset)}><RotateCcw className="size-5" />Recreate</button>
        <button className={action} onClick={() => assetToRef(asset)} disabled={asset.kind !== 'image'}><ImagePlus className="size-5" />As ref</button>
        <button className={action} onClick={() => set({ modal: { type: 'move', assetIds: [asset.id] } })}><FolderInput className="size-5" />Move</button>
        <button className={action} onClick={() => downloadAsset(asset)}><Download className="size-5" />Download</button>
        {asset.kind === 'image'
          ? <button className={clsx(action, 'text-accent')} onClick={() => animateAsset(asset)}><Clapperboard className="size-5" />Animate</button>
          : <button className={action} onClick={onInfo}><InfoIcon className="size-5" />Info</button>}
        <button className={clsx(action, 'text-[#ff8a95]')} onClick={() => deleteAssets(workspaceId!, [asset.id])}><Trash2 className="size-5" />Delete</button>
      </div>
    </div>
  );
}

function InfoSheet({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const start = useRef<number | null>(null);
  const [dy, setDy] = useState(0);
  return (
    <div className="fixed inset-0 z-[45]">
      <div className="fade-in absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="sheet-in absolute inset-x-0 bottom-0 flex max-h-[75dvh] flex-col rounded-t-3xl border-t border-line bg-panel pb-safe"
        style={{ transform: `translateY(${Math.max(dy, 0)}px)`, transition: start.current === null ? 'transform 0.2s' : 'none' }}
      >
        {/* Drag the handle down to close. */}
        <div
          className="flex shrink-0 cursor-grab justify-center pb-2 pt-3"
          onTouchStart={e => { start.current = e.touches[0].clientY; }}
          onTouchMove={e => { if (start.current !== null) setDy(e.touches[0].clientY - start.current); }}
          onTouchEnd={() => { const close = dy > 80; start.current = null; setDy(0); if (close) onClose(); }}
        >
          <div className="h-1.5 w-10 rounded-full bg-white/25" />
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          {asset.kind === 'image' && (
            <button onClick={() => addToModelRefs(asset)}
              className="mb-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-line-strong bg-panel-2 text-sm font-medium active:bg-white/8">
              <Star className="size-4 text-accent" />Add to Model refs
            </button>
          )}
          <Info generationId={asset.generationId} />
        </div>
      </div>
    </div>
  );
}

export function MobileViewer() {
  const { viewer, set } = useStore();
  const asset = viewer ? viewer.list[viewer.index] : null;
  const stage = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [chrome, setChrome] = useState(true);
  const [info, setInfo] = useState(false);
  const [zoom, setZoom] = useState<Zoom>({ s: 1, x: 0, y: 0 });
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [animate, setAnimate] = useState(false);

  // Live values for the native touch listeners (avoid stale closures).
  const live = useRef({ zoom, info, viewer });
  live.current = { zoom, info, viewer };
  const g = useRef({
    mode: 'idle' as Mode, sx: 0, sy: 0, t0: 0, moved: 0,
    pinchDist: 0, pinchScale: 1, pinchMid: { x: 0, y: 0 }, zoomStart: { s: 1, x: 0, y: 0 } as Zoom,
    lastTap: 0, tapTimer: 0 as number | undefined,
  });

  const index = viewer?.index ?? -1;
  useEffect(() => { if (asset) markSeen(asset); }, [asset?.id]);
  // New item: reset zoom/drag and preload neighbours so swiping feels instant.
  useEffect(() => {
    setZoom({ s: 1, x: 0, y: 0 });
    setDrag({ x: 0, y: 0 });
    const v = useStore.getState().viewer;
    if (!v) return;
    for (const n of [v.list[v.index + 1], v.list[v.index - 1]]) if (n?.kind === 'image') new Image().src = n.url;
  }, [index]);

  useEffect(() => {
    if (!viewer) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [Boolean(viewer)]);

  const go = (delta: number) => {
    const v = useStore.getState().viewer;
    if (!v) return false;
    const next = v.index + delta;
    if (next < 0 || next >= v.list.length) return false;
    set({ viewer: { ...v, index: next } });
    return true;
  };

  const close = () => {
    setAnimate(true);
    setDrag(d => ({ x: 0, y: Math.max(d.y, 0) + window.innerHeight }));
    window.setTimeout(() => set({ viewer: null }), 180);
  };

  useEffect(() => {
    const el = stage.current;
    if (!el || !viewer) return;
    const s = g.current;

    const onStart = (e: TouchEvent) => {
      if (live.current.info) return;
      setAnimate(false);
      if (e.touches.length >= 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        s.mode = 'pinch';
        s.pinchDist = dist(a, b);
        s.pinchMid = mid(a, b);
        s.zoomStart = { ...live.current.zoom };
        setDrag({ x: 0, y: 0 });
        return;
      }
      const t = e.touches[0];
      s.sx = t.clientX; s.sy = t.clientY; s.t0 = Date.now(); s.moved = 0;
      s.zoomStart = { ...live.current.zoom };
      s.mode = live.current.zoom.s > 1.01 ? 'pan' : 'undecided';
    };

    const onMove = (e: TouchEvent) => {
      if (live.current.info) return;
      e.preventDefault(); // keep the page itself from scrolling/zooming
      if (s.mode === 'pinch' && e.touches.length >= 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        const m = mid(a, b);
        const scale = Math.max(1, Math.min(MAX_ZOOM, (s.zoomStart.s * dist(a, b)) / s.pinchDist));
        // Keep the point between the fingers under the fingers while zooming.
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        const k = scale / s.zoomStart.s;
        const x = m.x - cx - k * (s.pinchMid.x - cx - s.zoomStart.x);
        const y = m.y - cy - k * (s.pinchMid.y - cy - s.zoomStart.y);
        setZoom(clampPan({ s: scale, x, y }));
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - s.sx, dy = t.clientY - s.sy;
      s.moved = Math.max(s.moved, Math.hypot(dx, dy));
      if (s.mode === 'pan') { setZoom(clampPan({ ...s.zoomStart, x: s.zoomStart.x + dx, y: s.zoomStart.y + dy })); return; }
      if (s.mode === 'undecided' && s.moved > 10) s.mode = Math.abs(dx) > Math.abs(dy) ? 'swipeX' : 'swipeY';
      if (s.mode === 'swipeX') {
        const v = live.current.viewer!;
        const edge = (dx > 0 && v.index === 0) || (dx < 0 && v.index === v.list.length - 1);
        setDrag({ x: edge ? dx * 0.3 : dx, y: 0 }); // rubber-band at the ends
      } else if (s.mode === 'swipeY') {
        setDrag({ x: 0, y: dy });
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (live.current.info) return;
      const mode = s.mode;
      if (mode === 'pinch') {
        if (e.touches.length === 1) { // one finger left: continue as a pan
          const t = e.touches[0];
          s.sx = t.clientX; s.sy = t.clientY; s.zoomStart = { ...live.current.zoom }; s.mode = 'pan';
          return;
        }
        if (live.current.zoom.s < 1.05) { setAnimate(true); setZoom({ s: 1, x: 0, y: 0 }); }
        s.mode = 'idle';
        return;
      }
      if (e.touches.length) return;
      s.mode = 'idle';
      const t = e.changedTouches[0];
      const dx = t.clientX - s.sx, dy = t.clientY - s.sy;

      if (s.moved < 10 && Date.now() - s.t0 < 350) {
        // Tap: wait briefly to see whether it becomes a double-tap.
        const now = Date.now();
        if (now - s.lastTap < TAP_MS) {
          window.clearTimeout(s.tapTimer);
          s.lastTap = 0;
          setAnimate(true);
          const z = live.current.zoom;
          if (z.s > 1.01) setZoom({ s: 1, x: 0, y: 0 });
          else {
            const ns = 2.5;
            const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
            setZoom(clampPan({ s: ns, x: (cx - t.clientX) * (ns - 1), y: (cy - t.clientY) * (ns - 1) }));
          }
        } else {
          s.lastTap = now;
          s.tapTimer = window.setTimeout(() => setChrome(c => !c), TAP_MS);
        }
        return;
      }

      setAnimate(true);
      if (mode === 'swipeX') {
        const dir = dx < -SWIPE_X ? 1 : dx > SWIPE_X ? -1 : 0;
        const v = live.current.viewer!;
        const possible = dir !== 0 && v.index + dir >= 0 && v.index + dir < v.list.length;
        if (possible) {
          setDrag({ x: -dir * window.innerWidth, y: 0 });
          window.setTimeout(() => { setAnimate(false); go(dir); }, 170);
        } else setDrag({ x: 0, y: 0 });
      } else if (mode === 'swipeY') {
        if (dy > SWIPE_DOWN) close();
        else {
          setDrag({ x: 0, y: 0 });
          if (dy < -SWIPE_UP) setInfo(true);
        }
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      window.clearTimeout(s.tapTimer);
    };
  }, [Boolean(viewer)]);

  if (!viewer || !asset) return null;

  // Dragging down shrinks the media and fades the backdrop, like Photos.
  const down = Math.max(drag.y, 0);
  const shrink = 1 - Math.min(down, 400) / 1600;
  const backdrop = 1 - Math.min(down, 400) / 500;
  const transform = `translate3d(${drag.x + zoom.x}px, ${drag.y + zoom.y}px, 0) scale(${zoom.s * shrink})`;
  const showChrome = chrome && zoom.s <= 1.01 && down < 10 && Math.abs(drag.x) < 10;

  return createPortal(
    <div className="fixed inset-0 z-40 select-none overflow-hidden" style={{ backgroundColor: `rgba(0,0,0,${backdrop})` }}>
      <div ref={stage} className="absolute inset-0 flex items-center justify-center" style={{ touchAction: 'none' }}>
        <div
          className="flex size-full items-center justify-center will-change-transform"
          style={{ transform, transition: animate ? 'transform 0.18s ease-out' : 'none' }}
        >
          {asset.kind === 'video' ? (
            <video
              key={asset.id}
              ref={el => {
                if (el && el !== videoRef.current) {
                  // iOS only autoplays videos that are muted before loading.
                  el.muted = rememberMuted;
                  el.defaultMuted = true;
                  el.play().catch(() => {});
                  el.addEventListener('canplay', () => { if (el.paused) el.play().catch(() => {}); }, { once: true });
                }
                videoRef.current = el;
                if (el !== video) setVideo(el);
              }}
              src={asset.url} poster={asset.thumbUrl || undefined}
              autoPlay loop playsInline muted
              className="max-h-full max-w-full"
            />
          ) : (
            <img key={asset.id} src={asset.url} alt={asset.prompt} draggable={false} className="max-h-full max-w-full object-contain" />
          )}
        </div>
      </div>

      {/* Controls float over the media; tap the media to hide/show them. */}
      <div className={clsx('pointer-events-none absolute inset-0 flex flex-col justify-between transition-opacity duration-200', showChrome ? 'opacity-100' : 'opacity-0')}>
        <div className={clsx('pt-safe flex items-center justify-between bg-gradient-to-b from-black/60 to-transparent px-3 pb-6 pt-2', showChrome && 'pointer-events-auto')}>
          <span className="rounded-full bg-black/35 px-2.5 py-1 text-xs text-white/85 backdrop-blur">{viewer.index + 1} / {viewer.list.length}</span>
          <button aria-label="Close" onClick={close} className="flex size-10 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur">
            <X className="size-5" />
          </button>
        </div>
        <div className={clsx('pb-safe bg-gradient-to-t from-black/75 via-black/40 to-transparent pb-3 pt-10', showChrome && 'pointer-events-auto')}>
          {asset.kind === 'video' && <VideoControls video={video} />}
          <ActionBar asset={asset} onInfo={() => setInfo(true)} />
          <button onClick={() => setInfo(true)} className="mx-auto mt-1 flex items-center gap-1 text-[10px] text-white/45">
            <ChevronUp className="size-3" />Swipe up for details
          </button>
        </div>
      </div>

      {info && <InfoSheet asset={asset} onClose={() => setInfo(false)} />}
    </div>,
    document.body,
  );
}
