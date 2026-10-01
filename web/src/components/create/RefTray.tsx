import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { clsx } from 'clsx';
import { Film, Image as ImageIcon, Music, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { primaryRefField } from '../../lib/models';
import { AudioFace, Preview } from '../RefPicker';
import { Popover } from '../ui';
import { useStore } from '../../lib/store';
import type { ModelInfo, Ref, RefField } from '../../lib/types';

/** 'row': compact horizontal strip (desktop dock). 'stacked': roomy blocks for the phone sheet. */
type Layout = 'row' | 'stacked';

const kindLabel = (field: RefField) => (field.kind === 'image' ? 'Image' : field.kind === 'video' ? 'Video' : 'Audio');

function Thumb({ item, badge, onRemove, layout, tall }: { item: Ref; badge?: string; onRemove: () => void; layout: Layout; tall?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const [zoom, setZoom] = useState(false);
  // A drag to reorder also ends in a click; only open the zoom when the pointer barely moved.
  const down = useRef<{ x: number; y: number } | null>(null);
  const stacked = layout === 'stacked';
  return (
    <>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        className={clsx(
          'group relative shrink-0 cursor-zoom-in touch-none',
          stacked ? (tall ? 'aspect-[3/4] w-full' : 'aspect-square w-full') : 'size-14 md:size-16',
          isDragging && 'z-10 opacity-80',
        )}
        {...attributes}
        {...listeners}
        onPointerDownCapture={e => { down.current = { x: e.clientX, y: e.clientY }; }}
        onClick={e => {
          const start = down.current;
          if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) setZoom(true);
        }}
        title={item.kind === 'audio' ? `${item.name}: click to play, drag to reorder` : 'Click to zoom, drag to reorder'}
      >
        <div className={clsx('size-full overflow-hidden border border-line bg-panel-2', stacked ? 'rounded-2xl' : 'rounded-xl')}>
          {item.kind === 'audio' ? <AudioFace name={item.name} size={stacked ? 'md' : 'sm'} /> :
            item.thumbUrl ? <img src={item.thumbUrl} alt={item.name} draggable={false} className="size-full object-cover" /> :
            <div className="flex size-full items-center justify-center text-faint"><Film className="size-5" /></div>}
        </div>
        {badge && (
          <span className={clsx('pointer-events-none absolute rounded-md bg-black/70 font-medium text-accent',
            stacked ? 'bottom-1.5 left-1.5 px-1.5 text-xs leading-5' : 'bottom-0.5 left-0.5 px-1 text-[10px] leading-4')}>{badge}</span>
        )}
        <button
          aria-label={`Remove ${item.name}`}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className={clsx(
            'absolute flex items-center justify-center rounded-full text-fg shadow',
            stacked
              ? 'right-1.5 top-1.5 size-7 bg-black/65 backdrop-blur'
              : '-right-1.5 -top-1.5 size-6 border border-line-strong bg-panel text-muted hover:text-fg md:opacity-0 md:group-hover:opacity-100',
          )}
        >
          <X className={stacked ? 'size-4' : 'size-3.5'} />
        </button>
      </div>
      {zoom && <Preview item={item} action={{ label: 'Remove from create box', onClick: onRemove }} onClose={() => setZoom(false)} />}
    </>
  );
}

function AddTile({ field, layout, tall, showKind }: { field: RefField; layout: Layout; tall?: boolean; showKind: boolean }) {
  const set = useStore(s => s.set);
  const stacked = layout === 'stacked';
  return (
    <button
      onClick={() => set({ modal: { type: 'refPicker', fieldKey: field.key } })}
      className={clsx(
        'flex shrink-0 flex-col items-center justify-center gap-1 border border-dashed border-line-strong text-muted transition hover:border-accent/60 hover:text-fg active:bg-white/5',
        stacked ? clsx('w-full rounded-2xl', tall ? 'aspect-[3/4]' : 'aspect-square') : 'size-14 rounded-xl md:size-16',
      )}
      title={field.description || `Add ${field.kind} reference (up to ${field.max})`}
    >
      <Plus className={stacked ? 'size-6' : 'size-5'} />
      {showKind && <span className={stacked ? 'text-xs' : 'text-[10px]'}>{stacked ? `Add ${kindLabel(field).toLowerCase()}` : kindLabel(field)}</span>}
    </button>
  );
}

function useFieldRefs(field: RefField) {
  const refs = useStore(s => s.draft.refSlots[field.key]) || [];
  const patchDraft = useStore(s => s.patchDraft);
  const update = (next: Ref[]) => patchDraft({ refSlots: { ...useStore.getState().draft.refSlots, [field.key]: next } });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );
  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    update(arrayMove(refs, refs.findIndex(r => r.id === e.active.id), refs.findIndex(r => r.id === e.over!.id)));
  }
  return { refs, update, sensors, onDragEnd };
}

function FieldLabel({ field, count, className }: { field: RefField; count?: string; className?: string }) {
  return (
    <div className={clsx('flex items-baseline gap-1.5 text-sm', className)} title={field.description}>
      <span className="font-medium text-fg">{field.label}</span>
      {field.required ? <span className="text-accent">*</span> : <span className="text-xs text-faint">optional</span>}
      {count && <span className="ml-auto text-xs tabular-nums text-faint">{count}</span>}
    </div>
  );
}

/** Compact strip used in the desktop dock. */
function RowField({ field, isPrimary, showLabel }: { field: RefField; isPrimary: boolean; showLabel: boolean }) {
  const { refs, update, sensors, onDragEnd } = useFieldRefs(field);
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      {showLabel && (
        <span className="max-w-20 text-xs leading-tight text-muted" title={field.description}>
          {field.label}{field.required ? <span className="text-accent"> *</span> : <span className="block text-[10px] text-faint">optional</span>}
        </span>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={refs.map(r => r.id)} strategy={horizontalListSortingStrategy}>
          {refs.map((r, i) => (
            <Thumb key={r.id} item={r} layout="row" badge={isPrimary ? `@image${i + 1}` : undefined} onRemove={() => update(refs.filter(x => x.id !== r.id))} />
          ))}
        </SortableContext>
      </DndContext>
      {refs.length < field.max && <AddTile field={field} layout="row" showKind={!refs.length} />}
    </div>
  );
}

/** A one-file slot (start frame, end frame…) shown as a large tile. */
function SlotField({ field, isPrimary }: { field: RefField; isPrimary: boolean }) {
  const { refs, update, sensors, onDragEnd } = useFieldRefs(field);
  const item = refs[0];
  return (
    <div className="min-w-0 space-y-1.5">
      <FieldLabel field={field} />
      {item ? (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <SortableContext items={[item.id]}>
            <Thumb item={item} layout="stacked" tall badge={isPrimary ? '@image1' : undefined} onRemove={() => update([])} />
          </SortableContext>
        </DndContext>
      ) : <AddTile field={field} layout="stacked" tall showKind />}
    </div>
  );
}

/** A multi-file slot shown as a labelled grid. */
function GridField({ field, isPrimary }: { field: RefField; isPrimary: boolean }) {
  const { refs, update, sensors, onDragEnd } = useFieldRefs(field);
  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} count={`${refs.length}/${field.max}`} />
      <div className="grid grid-cols-4 gap-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={refs.map(r => r.id)} strategy={rectSortingStrategy}>
            {refs.map((r, i) => (
              <Thumb key={r.id} item={r} layout="stacked" badge={isPrimary ? `@image${i + 1}` : undefined} onRemove={() => update(refs.filter(x => x.id !== r.id))} />
            ))}
          </SortableContext>
        </DndContext>
        {refs.length < field.max && <AddTile field={field} layout="stacked" showKind={!refs.length} />}
      </div>
    </div>
  );
}

/** Desktop: menu for the model's less-used reference inputs, so the row stays short. */
function ExtraInputs({ fields, onPick }: { fields: RefField[]; onPick: (f: RefField) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} title="Add input" width="w-60" trigger={
      <button onClick={() => setOpen(!open)} title="More reference inputs"
        className="flex h-14 shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-line px-3 text-xs text-muted transition hover:border-accent/60 hover:text-fg md:h-16">
        <Plus className="size-4" />Input
      </button>
    }>
      {fields.map(f => (
        <button key={f.key} onClick={() => { setOpen(false); onPick(f); }} title={f.description}
          className="flex h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-white/6">
          {f.kind === 'video' ? <Film className="size-4 text-muted" /> : f.kind === 'audio' ? <Music className="size-4 text-muted" /> : <ImageIcon className="size-4 text-muted" />}
          <span className="flex-1">{f.label}</span>
          {f.max > 1 && <span className="text-xs text-faint">up to {f.max}</span>}
        </button>
      ))}
    </Popover>
  );
}

export function RefTray({ model, layout = 'row' }: { model?: ModelInfo; layout?: Layout }) {
  const refSlots = useStore(s => s.draft.refSlots);
  const set = useStore(s => s.set);
  // Inputs the user opened from the "+ Input" menu (reset when the model changes).
  const [revealed, setRevealed] = useState<string[]>([]);
  useEffect(() => setRevealed([]), [model?.id]);
  if (!model?.refFields.length) return null;
  const primary = primaryRefField(model);

  if (layout === 'stacked') {
    const slots = model.refFields.filter(f => f.max === 1);
    const grids = model.refFields.filter(f => f.max > 1);
    return (
      <div className="space-y-4">
        {slots.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {slots.map(f => <SlotField key={f.key} field={f} isPrimary={f.key === primary?.key} />)}
          </div>
        )}
        {grids.map(f => <GridField key={f.key} field={f} isPrimary={f.key === primary?.key} />)}
      </div>
    );
  }

  const fields = model.refFields;
  const shown = (f: RefField, i: number) => fields.length <= 2 || i === 0 || f.required || f.key === primary?.key
    || (refSlots[f.key] || []).length > 0 || revealed.includes(f.key);
  const visible = fields.filter(shown);
  const hidden = fields.filter((f, i) => !shown(f, i));
  const many = fields.length > 1;
  return (
    <div className="flex items-center gap-5 pt-2">
      {/* The menu sits outside the scrolling strip so its popover isn't clipped. */}
      <div className="no-scrollbar flex min-w-0 items-center gap-5 overflow-x-auto px-1 pb-1">
        {visible.map(f => (
          <RowField key={f.key} field={f} isPrimary={f.key === primary?.key} showLabel={many || f.key !== primary?.key} />
        ))}
      </div>
      {hidden.length > 0 && (
        <div className="shrink-0 pb-1">
          <ExtraInputs fields={hidden} onPick={f => { setRevealed(r => [...r, f.key]); set({ modal: { type: 'refPicker', fieldKey: f.key } }); }} />
        </div>
      )}
    </div>
  );
}
