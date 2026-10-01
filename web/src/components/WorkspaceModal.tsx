import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { keys, queryClient, saveFolderLabel, useMySettings, useWorkspaces } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import type { Workspace } from '../lib/types';
import { Button, Field, Modal, inputClass } from './ui';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';

export function WorkspaceModal() {
  const { modal, set, toast, setWorkspace, workspaceId } = useStore();
  const open = modal?.type === 'workspace';
  const editingId = open ? modal.id : undefined;
  const { data: workspaces = [] } = useWorkspaces();
  const { data: settings } = useMySettings();
  const existing = workspaces.find(w => w.id === editingId);
  const [name, setName] = useState('');
  const [imageDir, setImageDir] = useState('');
  const [videoDir, setVideoDir] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(existing?.name || '');
    setImageDir(existing?.imageExportDir || '');
    setVideoDir(existing?.videoExportDir || '');
    setTouched(Boolean(existing));
  }, [open, existing?.id]);

  // For new workspaces, suggest export folders from the name until the user edits them.
  useEffect(() => {
    if (touched || existing) return;
    setImageDir(name ? `${slug(name)}/images` : '');
    setVideoDir(name ? `${slug(name)}/videos` : '');
  }, [name, touched, existing]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { name, imageExportDir: imageDir, videoExportDir: videoDir };
      const ws = existing ? await api.patch<Workspace>(`/api/workspaces/${existing.id}`, body) : await api.post<Workspace>('/api/workspaces', body);
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
      if (!existing) setWorkspace(ws.id);
      set({ modal: null });
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!existing || !confirm(`Delete workspace "${existing.name}" with ALL its generations, references and elements? Files saved to disk are kept.`)) return;
    try {
      await api.del(`/api/workspaces/${existing.id}`);
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
      if (workspaceId === existing.id) setWorkspace(workspaces.find(w => w.id !== existing.id)!.id);
      set({ modal: null });
    } catch (error) { toast(errorText(error), 'error'); }
  }

  const where = (dir: string) => saveFolderLabel(settings?.saveLabel, dir || '…') || `your save location/${dir || '…'}`;
  return (
    <Modal open={open} onClose={() => set({ modal: null })} title={existing ? 'Workspace settings' : 'New workspace'}>
      <form onSubmit={save} className="space-y-4 p-5">
        <Field label="Name"><input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Mia" autoFocus={!existing} required /></Field>
        <Field label="Image save folder" hint={<>Saved to <span className="break-all text-muted">{where(imageDir)}</span></>}>
          <input className={inputClass} value={imageDir} onChange={e => { setTouched(true); setImageDir(e.target.value); }} required />
        </Field>
        <Field label="Video save folder" hint={<>Saved to <span className="break-all text-muted">{where(videoDir)}</span></>}>
          <input className={inputClass} value={videoDir} onChange={e => { setTouched(true); setVideoDir(e.target.value); }} required />
        </Field>
        <div className="flex items-center gap-2 pt-2">
          {existing && workspaces.length > 1 && <Button type="button" variant="danger" onClick={remove}>Delete</Button>}
          <Button type="submit" variant="primary" className="ml-auto" loading={busy}>{existing ? 'Save' : 'Create workspace'}</Button>
        </div>
      </form>
    </Modal>
  );
}
