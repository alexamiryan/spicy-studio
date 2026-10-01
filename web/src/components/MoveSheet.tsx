import { Folder as FolderIcon, FolderPlus, Inbox } from 'lucide-react';
import { useState } from 'react';
import { createFolder, moveAssets } from '../lib/actions';
import { useFolders } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import { Button, Modal, inputClass } from './ui';

export function MoveSheet() {
  const { modal, set, workspaceId: ws, toast } = useStore();
  const open = modal?.type === 'move';
  const ids = open ? modal.assetIds : [];
  const { data } = useFolders(ws);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function move(folderId: string | null, folderName?: string) {
    setBusy(true);
    await moveAssets(ws!, ids, folderId, folderName);
    setBusy(false);
    set({ modal: null, viewer: null });
  }

  async function createAndMove(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const folder = await createFolder(ws!, name.trim());
      setName('');
      await move(folder.id, folder.name);
    } catch (error) { toast(errorText(error), 'error'); }
  }

  const row = 'flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm hover:bg-white/6 disabled:opacity-50';
  return (
    <Modal open={open} onClose={() => set({ modal: null })} title={`Move ${ids.length} item${ids.length === 1 ? '' : 's'} to…`}>
      <div className="space-y-1 p-3 pb-safe">
        <form onSubmit={createAndMove} className="mb-2 flex gap-2">
          <input className={inputClass} placeholder="New folder name" value={name} onChange={e => setName(e.target.value)} />
          <Button type="submit" disabled={!name.trim()} loading={busy}><FolderPlus className="size-4" /> Create</Button>
        </form>
        <button disabled={busy} className={row} onClick={() => move(null)}><Inbox className="size-5 text-muted" /> Unsorted</button>
        {data?.folders.map(f => (
          <button key={f.id} disabled={busy} className={row} onClick={() => move(f.id, f.name)}>
            <FolderIcon className="size-5 text-muted" /><span className="truncate">{f.name}</span><span className="ml-auto text-xs text-faint">{f.count}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
