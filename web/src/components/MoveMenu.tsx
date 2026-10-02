import { ChevronDown, FolderInput } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Popover } from './ui';

export interface MoveTarget { key: string; label: string; icon: ReactNode; hint?: string; onSelect: () => void }

/** One "Move to" button for a selection; the menu lists where the items can go. */
export function MoveMenu({ targets, disabled, busy, size, side = 'bottom', align = 'right', trigger }: {
  targets: MoveTarget[]; disabled?: boolean; busy?: boolean; size?: 'sm'; side?: 'top' | 'bottom'; align?: 'left' | 'right';
  /** Custom trigger (gets the open/close toggle); defaults to a "Move to" button. */
  trigger?: (toggle: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} title="Move to" side={side} align={align} width="w-72"
      trigger={trigger ? trigger(() => setOpen(o => !o)) :
        <Button size={size} disabled={disabled || !targets.length} loading={busy} onClick={() => setOpen(o => !o)}>
          {!busy && <FolderInput className="size-4" />}Move to<ChevronDown className="size-3.5 opacity-60" />
        </Button>
      }>
      {targets.map(t => (
        <button key={t.key} onClick={() => { setOpen(false); t.onSelect(); }}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/8 active:bg-white/10">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-panel-3 text-accent">{t.icon}</span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t.label}</span>
            {t.hint && <span className="block text-xs text-faint">{t.hint}</span>}
          </span>
        </button>
      ))}
    </Popover>
  );
}
