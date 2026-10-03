import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Clock, Copy, Loader2, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { dismissGeneration, recreate, retryGeneration } from '../lib/actions';
import { useStore } from '../lib/store';
import type { GenerationDetail } from '../lib/types';
import { Info } from './Viewer';
import { Button, Modal } from './ui';

const LABEL: Record<string, string> = { pending: 'Submitting', queued: 'Queued', running: 'Generating', saving: 'Saving', failed: 'Failed', succeeded: 'Done' };

/** Details for an in-progress or failed generation: status, full error, generation info and actions. */
export function GenerationModal() {
  const { modal, set, workspaceId, toast, recreating } = useStore();
  const id = modal?.type === 'generation' ? modal.id : null;
  const [busy, setBusy] = useState(false);
  const { data: g } = useQuery({
    queryKey: ['generation', id],
    enabled: Boolean(id),
    queryFn: () => api.get<GenerationDetail>(`/api/generations/${id}`),
    refetchInterval: q => (q.state.data && !['failed', 'succeeded'].includes(q.state.data.status) ? 3000 : false),
  });
  const close = () => set({ modal: null });
  const failed = g?.status === 'failed';
  const active = g && !['failed', 'succeeded'].includes(g.status);

  return (
    <Modal open={Boolean(id)} onClose={close} wide title={
      <span className="flex items-center gap-2">
        {failed ? <AlertTriangle className="size-4 text-danger" /> : active ? (g!.status === 'queued' || g!.status === 'pending' ? <Clock className="size-4 text-muted" /> : <Loader2 className="size-4 animate-spin text-muted" />) : null}
        <span className={clsx(failed && 'text-danger')}>{g ? LABEL[g.status] || g.status : 'Generation'}</span>
        {g && <span className="truncate text-sm font-normal text-muted">· {g.modelName}</span>}
      </span>
    } footer={g && (
      <div className="flex flex-wrap items-center gap-2">
        {(failed || active) && (
          <Button variant="ghost" onClick={async () => { await dismissGeneration(g.id, workspaceId!); close(); }}>
            <X className="size-4" />{failed ? 'Dismiss' : 'Remove'}
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          {failed && (
            <Button loading={busy} onClick={async () => { setBusy(true); const ok = await retryGeneration(g.id, workspaceId!); setBusy(false); if (ok) close(); }}>
              {!busy && <RefreshCw className="size-4" />}Retry
            </Button>
          )}
          <Button variant="primary" loading={recreating === g.id} disabled={Boolean(recreating)} onClick={async () => { await recreate(g.id); close(); }}>
            {recreating !== g.id && <RotateCcw className="size-4" />}Recreate
          </Button>
        </div>
      </div>
    )}>
      <div className="space-y-5 p-5">
        {failed && g?.error && (
          <div className="rounded-2xl border border-danger/30 bg-danger/5 p-3">
            <div className="mb-1 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-danger">
              Error
              <button className="flex items-center gap-1 text-xs normal-case text-muted hover:text-fg" onClick={() => { navigator.clipboard?.writeText(g.error || ''); toast('Error copied'); }}>
                <Copy className="size-3.5" />Copy
              </button>
            </div>
            <p className="select-text whitespace-pre-wrap break-words text-sm text-fg">{g.error}</p>
          </div>
        )}
        {active && (
          <p className="text-sm text-muted">
            {g!.status === 'queued' || g!.status === 'pending' ? 'Waiting for the provider to start…' : 'The provider is generating; this updates automatically.'}
          </p>
        )}
        {id && <Info generationId={id} />}
      </div>
    </Modal>
  );
}
