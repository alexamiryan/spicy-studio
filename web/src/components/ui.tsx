import { clsx } from 'clsx';
import { Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../lib/store';

export function useIsMobile() {
  const query = '(max-width: 767px)';
  const [mobile, setMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}

type Variant = 'primary' | 'ghost' | 'subtle' | 'danger' | 'outline';

export function Button({ variant = 'subtle', size = 'md', loading, className, children, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition select-none disabled:opacity-50 whitespace-nowrap',
        size === 'sm' && 'h-8 px-3 text-sm', size === 'md' && 'h-10 px-4 text-sm', size === 'lg' && 'h-12 px-5 text-base',
        variant === 'primary' && 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95',
        variant === 'subtle' && 'bg-panel-3 text-fg hover:bg-white/12',
        variant === 'ghost' && 'text-muted hover:text-fg hover:bg-white/6',
        variant === 'outline' && 'border border-line-strong text-fg hover:bg-white/6',
        variant === 'danger' && 'bg-danger/15 text-danger hover:bg-danger/25',
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function IconButton({ className, label, children, active, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-10 shrink-0 items-center justify-center rounded-xl transition disabled:opacity-40',
        active ? 'bg-white/12 text-fg' : 'text-muted hover:text-fg hover:bg-white/8',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin text-muted', className || 'size-5')} />;
}

/** Centered dialog on desktop, bottom sheet on phones. */
export function Modal({ open, onClose, title, children, footer, wide, full, bare }: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; full?: boolean; bare?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6">
      <div className="fade-in absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        className={clsx(
          'sheet-in md:fade-in relative flex w-full flex-col overflow-hidden border border-line bg-panel shadow-2xl',
          'max-h-[92dvh] rounded-t-3xl md:rounded-3xl',
          full ? 'h-[92dvh] md:h-[85vh] md:max-w-6xl' : wide ? 'md:max-w-3xl' : 'md:max-w-lg',
        )}
      >
        {!bare && (
          <div className="flex items-center gap-3 border-b border-line px-5 py-3">
            <div className="mx-auto h-1 w-10 rounded-full bg-white/20 md:hidden absolute left-1/2 top-1.5 -translate-x-1/2" />
            <div className="min-w-0 flex-1 truncate text-base font-semibold">{title}</div>
            <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
          </div>
        )}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="pb-safe border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Small anchored menu that opens upward (the create box lives at the bottom). Sheet on phones. */
export function Popover({ trigger, children, title, align = 'left', side = 'top', open, onOpenChange, width = 'w-72' }: {
  trigger: ReactNode; children: ReactNode; title?: string; align?: 'left' | 'right'; side?: 'top' | 'bottom';
  open: boolean; onOpenChange: (open: boolean) => void; width?: string;
}) {
  const mobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || mobile) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onOpenChange(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open, mobile, onOpenChange]);
  return (
    <div ref={ref} className="relative">
      {trigger}
      {open && !mobile && (
        <div className={clsx('fade-in absolute z-40 max-h-[60vh] overflow-y-auto rounded-2xl border border-line-strong bg-panel-2 p-2 shadow-2xl scrollbar-thin', width, align === 'right' ? 'right-0' : 'left-0', side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2')}>
          {children}
        </div>
      )}
      {mobile && <Modal open={open} onClose={() => onOpenChange(false)} title={title}><div className="p-3 pb-safe">{children}</div></Modal>}
    </div>
  );
}

export function Chip({ active, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...props}
      className={clsx(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-sm transition',
        active ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line bg-panel-3/60 text-fg hover:bg-white/10',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, className }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div className={clsx('inline-flex rounded-xl bg-panel-3/70 p-1', className)}>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx('h-8 rounded-lg px-3 text-sm font-medium transition', value === o.value ? 'bg-white/12 text-fg' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export const inputClass = 'h-11 w-full rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/60';

export function Toasts() {
  const toasts = useStore(s => s.toasts);
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4 pt-safe">
      {toasts.map(t => (
        <div key={t.id} className={clsx('fade-in pointer-events-auto max-w-md rounded-2xl border px-4 py-2.5 text-sm shadow-xl backdrop-blur',
          t.tone === 'error' ? 'border-danger/40 bg-[#2a1116]/95 text-[#ffc2c8]' : 'border-line-strong bg-panel-2/95 text-fg')}>
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-base font-medium">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

/** Calls onLongPress after holding ~450ms without moving; returns handlers to spread on an element. */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => { window.clearTimeout(timer.current); start.current = null; };
  return {
    fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse') return;
        fired.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        timer.current = window.setTimeout(() => { fired.current = true; navigator.vibrate?.(10); onLongPress(); }, 450);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: React.MouseEvent) => { if (fired.current) e.preventDefault(); },
    },
  };
}
