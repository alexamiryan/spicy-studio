import { clsx } from 'clsx';
import { Pause, Play, Scissors } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { invalidateGallery } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import type { Asset } from '../lib/types';
import { Button, Modal } from './ui';

const MIN = 0.5; // seconds; the server refuses shorter clips
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/**
 * Trim a video: drag the start/end handles (the preview follows), play the selection on a loop, and save it
 * as a new result next to the original. The original is kept.
 */
export function TrimModal() {
  const modal = useStore(s => s.modal);
  const asset = modal?.type === 'trim' ? modal.asset : null;
  return asset ? <Trimmer key={asset.id} asset={asset} /> : null;
}

function Trimmer({ asset }: { asset: Asset }) {
  const { set, toast } = useStore();
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(asset.duration || 0);
  const [range, setRange] = useState<[number, number]>([0, asset.duration || 0]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [start, end] = range;
  const close = () => set({ modal: null });

  const seek = (t: number) => { if (video.current) video.current.currentTime = t; setCurrent(t); };
  const setStart = (t: number) => setRange(([, e]) => [Math.min(Math.max(0, t), e - MIN), e]);
  const setEnd = (t: number) => setRange(([s]) => [s, Math.max(Math.min(duration, t), s + MIN)]);

  function toggle() {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < start || v.currentTime >= end - 0.05) v.currentTime = start;
      v.play().catch(() => {});
    } else v.pause();
  }

  // While playing, loop the selection checking every frame: timeupdate fires only ~4×/s, which would show
  // up to a quarter second of the ending you're cutting off.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const v = video.current;
      if (v && !v.paused && v.currentTime >= end) v.currentTime = start;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, start, end]);

  // Keys: Space plays the selection, I / O set start / end at the current frame.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') { e.preventDefault(); toggle(); }
      if (e.key === 'i' || e.key === 'I') setStart(video.current?.currentTime ?? 0);
      if (e.key === 'o' || e.key === 'O') setEnd(video.current?.currentTime ?? duration);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Drag a handle (or the playhead when the track itself is grabbed); the video shows the frame under it. */
  function drag(which: 'start' | 'end' | 'seek') {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      video.current?.pause();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      const at = (ev: { clientX: number }) => {
        const box = track.current!.getBoundingClientRect();
        return Math.min(Math.max((ev.clientX - box.left) / box.width, 0), 1) * duration;
      };
      const apply = (ev: { clientX: number }) => {
        const t = at(ev);
        if (which === 'start') { const s = Math.min(t, end - MIN); setStart(s); seek(Math.max(0, s)); }
        else if (which === 'end') { const x = Math.max(t, start + MIN); setEnd(x); seek(Math.min(duration, x)); }
        else seek(t);
      };
      apply(e);
      const move = (ev: PointerEvent) => apply(ev);
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
  }

  async function save() {
    setSaving(true);
    try {
      const created = await api.post<Asset>(`/api/assets/${asset.id}/trim`, { start, end });
      invalidateGallery(asset.workspaceId);
      // Show the new clip in the viewer: it sits right before the original (it's 1 µs newer).
      const viewer = useStore.getState().viewer;
      if (viewer) {
        const i = viewer.list.findIndex(a => a.id === asset.id);
        if (i >= 0) set({ viewer: { list: [...viewer.list.slice(0, i), created, ...viewer.list.slice(i)], index: i } });
      }
      set({ modal: null });
      toast('Trimmed copy added next to the original');
    } catch (error) { toast(errorText(error), 'error'); }
    setSaving(false);
  }

  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;
  const whole = start <= 0.02 && end >= duration - 0.02;

  return (
    <Modal open wide title={<span className="flex items-center gap-2"><Scissors className="size-4" />Trim video</span>} onClose={close}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full text-xs text-muted sm:w-auto sm:min-w-0 sm:flex-1">
            Keeps <span className="text-fg">{(end - start).toFixed(1)} s</span> of {duration.toFixed(1)} s. Saved as a new result; the original stays.
          </div>
          <Button variant="ghost" className="ml-auto" onClick={close}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!duration || whole} onClick={save}>{!saving && <Scissors className="size-4" />}Save trimmed</Button>
        </div>
      }>
      <div className="space-y-4 p-4">
        <div className="flex justify-center overflow-hidden rounded-2xl bg-black">
          <video ref={video} src={asset.url} playsInline preload="auto" className="max-h-[50dvh] w-auto max-w-full"
            onLoadedMetadata={e => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) { setDuration(d); setRange(([s, x]) => [Math.min(s, d - MIN), x && x <= d ? x : d]); }
            }}
            onTimeUpdate={e => setCurrent(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={toggle} />
        </div>

        {/* The track: dimmed outside the selection, handles at both ends, a playhead for the current frame. */}
        <div className="flex items-center gap-3">
          <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play selection'} title="Play the selection (Space)"
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-panel-3 hover:bg-white/12">
            {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
          </button>
          <div ref={track} onPointerDown={drag('seek')} className="relative h-12 flex-1 cursor-pointer touch-none select-none rounded-xl bg-white/5">
            <div className="absolute inset-y-0 left-0 rounded-l-xl bg-black/50" style={{ width: pct(start) }} />
            <div className="absolute inset-y-0 right-0 rounded-r-xl bg-black/50" style={{ left: pct(end) }} />
            <div className="absolute inset-y-0 border-y-2 border-accent" style={{ left: pct(start), right: `calc(100% - ${pct(end)})` }} />
            <div className="pointer-events-none absolute inset-y-1 w-0.5 -translate-x-1/2 rounded bg-white" style={{ left: pct(current) }} />
            {(['start', 'end'] as const).map(which => (
              <div key={which} onPointerDown={drag(which)} role="slider" aria-label={which === 'start' ? 'Start' : 'End'}
                aria-valuemin={0} aria-valuemax={duration} aria-valuenow={which === 'start' ? start : end}
                className="absolute inset-y-0 z-10 flex w-7 -translate-x-1/2 cursor-ew-resize items-center justify-center"
                style={{ left: pct(which === 'start' ? start : end) }}>
                <div className="h-full w-3 rounded-md bg-accent shadow" />
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          {(['start', 'end'] as const).map(which => (
            <div key={which} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-faint">{which === 'start' ? 'Start' : 'End'}</div>
                <div className="font-medium tabular-nums">{fmt(which === 'start' ? start : end)}</div>
              </div>
              <Button size="sm" variant="subtle" className={clsx('shrink-0')} title={`Set to the current frame (${which === 'start' ? 'I' : 'O'})`}
                onClick={() => (which === 'start' ? setStart(current) : setEnd(current))}>
                Set<span className="hidden sm:inline">&nbsp;to {fmt(current)}</span>
              </Button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
