import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bot, Check, Copy, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { queryClient, useWorkspaces } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import { Button, Field, Spinner, inputClass } from './ui';

type Perm = 'generate' | 'folders' | 'upload' | 'presets' | 'save' | 'delete';
interface AgentKey { id: string; name: string; last4: string; perms: Perm[]; workspaceIds: string[] | null; createdAt: string; lastUsedAt: string | null }
interface AgentsInfo { agents: AgentKey[]; perms: Perm[]; mcpUrl: string }

const KEY = ['agents'];
const PERM_LABELS: Record<Perm, { label: string; hint: string }> = {
  generate: { label: 'Generate', hint: 'Generate and price images and videos (spends your balance)' },
  folders: { label: 'Folders', hint: 'Create folders and move results' },
  upload: { label: 'Upload refs', hint: 'Add references and environment photos' },
  presets: { label: 'Presets', hint: 'Use your saved presets' },
  save: { label: 'Save', hint: 'Save results to your save location' },
  delete: { label: 'Delete', hint: 'Delete results' },
};
const DEFAULT_PERMS: Perm[] = ['generate', 'folders', 'upload', 'presets', 'save'];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');

/** Copy that also works over plain http on the LAN (no clipboard API there): falls back to selecting. */
function CopyBox({ text, rows = 1 }: { text: string; rows?: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async (el: HTMLTextAreaElement | null) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { el?.select(); document.execCommand?.('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };
  const area = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="flex items-start gap-2">
      <textarea ref={area} readOnly rows={rows} value={text} onFocus={e => e.currentTarget.select()}
        className="scrollbar-thin min-w-0 flex-1 resize-none rounded-xl border border-line bg-panel-2 px-3 py-2.5 font-mono text-xs text-fg outline-none" />
      <Button size="sm" className="mt-1.5 shrink-0" onClick={() => copy(area.current)}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={on}
      className={clsx('flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition',
        on ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line text-faint hover:text-muted')}>
      {on && <Check className="size-3" />}{children}
    </button>
  );
}

/** Permissions and workspace allowlist, as toggle chips. */
function Access({ perms, workspaceIds, onChange }: {
  perms: Perm[]; workspaceIds: string[] | null;
  onChange: (patch: { perms?: Perm[]; workspaceIds?: string[] | null }) => void;
}) {
  const { data: workspaces = [] } = useWorkspaces();
  const togglePerm = (p: Perm) => onChange({ perms: perms.includes(p) ? perms.filter(x => x !== p) : [...perms, p] });
  const toggleWs = (id: string) => {
    const current = workspaceIds || [];
    onChange({ workspaceIds: current.includes(id) ? current.filter(x => x !== id) : [...current, id] });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(PERM_LABELS) as Perm[]).map(p => (
          <Chip key={p} on={perms.includes(p)} onClick={() => togglePerm(p)} title={PERM_LABELS[p].hint}>{PERM_LABELS[p].label}</Chip>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Chip on={!workspaceIds} onClick={() => onChange({ workspaceIds: workspaceIds ? null : [] })} title="Every workspace, also ones you add later">All workspaces</Chip>
        {workspaceIds && workspaces.map(w => <Chip key={w.id} on={workspaceIds.includes(w.id)} onClick={() => toggleWs(w.id)}>{w.name}</Chip>)}
      </div>
      {workspaceIds && !workspaceIds.length && <p className="text-xs text-danger">Pick at least one workspace, or this key can't do anything.</p>}
    </div>
  );
}

/**
 * Instructions to paste into an agent's chat so it connects itself (Hermes can add MCP servers to its own
 * config). With a key it's ready to use; without one it has a placeholder for keys created earlier.
 */
function agentPrompt(url: string, token: string | null, workspaces?: string[] | null, perms?: Perm[]) {
  const key = token || '<paste the agent key here>';
  const scope = perms === undefined
    ? "The key's workspaces and permissions are set in Spicy Studio; a tool this key may not use says so."
    : workspaces ? `This key can only use the workspace${workspaces.length === 1 ? '' : 's'} ${workspaces.map(w => `"${w}"`).join(', ')}.` : 'This key can use all my workspaces.';
  const allowed = perms?.length ? `It's allowed to: ${perms.map(p => PERM_LABELS[p].label.toLowerCase()).join(', ')}.` : '';
  return `Connect to my Spicy Studio and use it for all image and video generation from now on (instead of generating with Higgsfield directly).

Spicy Studio is an MCP server (Streamable HTTP):
- URL: ${url}
- Auth header: Authorization: Bearer ${key}

1. Add it as an MCP server named "spicy-studio". For Hermes, add this to mcp_servers in ~/.hermes/config.yaml, then reload your MCP tools (or restart):

${hermesSnippet(url, key)}

2. Check the connection: call list_workspaces and list_models, and tell me what you see.

How to use it:
- ${[scope, allowed].filter(Boolean).join(' ')}
- Prefer "Auto" models from list_models: they go to the cheapest provider with enough balance. Uncensored and regular versions are separate Auto models; pick the one the task needs. Use get_model to see a model's settings and reference inputs.
- generate takes names or ids: workspace, model, references (reference or environment photo names, or result ids), folder (created if missing), preset. Mention elements as @Name in the prompt.
- Then call get_results with wait_seconds until status is "succeeded". Download a file's cleanUrl (metadata removed) or url with the same Authorization header, or call save_results to save it to my NAS.
- Generations cost real money: call quote when unsure, and never retry failures in a loop; tell me instead.
- Keep the key secret: don't print it, post it, or store it anywhere except your MCP config.`;
}

const hermesSnippet = (url: string, token: string) =>
  `mcp_servers:\n  spicy-studio:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer ${token}"\n    timeout: 360`;

/** Settings → Agents: keys for MCP clients (e.g. Hermes agents) that generate through the studio. */
export function AgentsSettings() {
  const toast = useStore(s => s.toast);
  const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<AgentsInfo>('/api/agents') });
  const [form, setForm] = useState<{ name: string; perms: Perm[]; workspaceIds: string[] | null } | null>(null);
  const [created, setCreated] = useState<{ name: string; token: string; perms: Perm[]; workspaceIds: string[] | null } | null>(null);
  const { data: workspaces = [] } = useWorkspaces();
  const wsNames = (ids: string[] | null) => (ids ? workspaces.filter(w => ids.includes(w.id)).map(w => w.name) : null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    try {
      const result = await api.post<{ token: string; agent: AgentKey }>('/api/agents', form);
      setCreated({ name: result.agent.name, token: result.token, perms: result.agent.perms, workspaceIds: result.agent.workspaceIds });
      setForm(null);
      queryClient.invalidateQueries({ queryKey: KEY });
    } catch (error) { toast(errorText(error), 'error'); }
    setBusy(false);
  }

  async function update(id: string, patch: Partial<AgentKey>) {
    queryClient.setQueryData<AgentsInfo>(KEY, d => d && { ...d, agents: d.agents.map(a => (a.id === id ? { ...a, ...patch } : a)) });
    try { await api.patch(`/api/agents/${id}`, patch); }
    catch (error) { toast(errorText(error), 'error'); }
    queryClient.invalidateQueries({ queryKey: KEY });
  }

  async function remove(agent: AgentKey) {
    if (!confirm(`Delete the key "${agent.name}"? Agents using it stop working right away.`)) return;
    try { await api.del(`/api/agents/${agent.id}`); queryClient.invalidateQueries({ queryKey: KEY }); }
    catch (error) { toast(errorText(error), 'error'); }
  }

  if (isLoading || !data) return <div className="flex justify-center py-10"><Spinner /></div>;

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-3 rounded-2xl border border-line p-4">
        <p className="text-sm text-muted">
          Agents connect over MCP and work like you in the studio: workspaces, folders, Auto models, references, presets and
          saving with metadata stripped. Their results show up here live, marked with the agent's name.
        </p>
        <Field label="MCP server URL" hint="Streamable HTTP. Use your server's LAN address or Tailscale name if this shows localhost.">
          <CopyBox text={data.mcpUrl} />
        </Field>
        <details className="group">
          <summary className="cursor-pointer select-none text-sm font-medium text-muted hover:text-fg">Prompt for an agent with an existing key</summary>
          <div className="mt-2 space-y-1">
            <CopyBox text={agentPrompt(data.mcpUrl, null)} rows={8} />
            <p className="text-xs text-faint">Replace the key placeholder before pasting. New keys come with a ready prompt that includes the key.</p>
          </div>
        </details>
      </div>

      {created && (
        <div className="space-y-3 rounded-2xl border border-accent/40 bg-accent/5 p-4">
          <div className="text-sm font-medium">Key for "{created.name}"</div>
          <p className="text-xs text-muted">Copy it now: it's shown only once. Anyone with this key can act as you within its permissions.</p>
          <CopyBox text={created.token} />
          <Field label="Prompt for your agent" hint="Paste it into the agent's chat: it adds the server to its config and checks the connection. Includes the key.">
            <CopyBox text={agentPrompt(data.mcpUrl, created.token, wsNames(created.workspaceIds), created.perms)} rows={8} />
          </Field>
          <Field label="Hermes config (config.yaml)" hint="Other MCP clients: the same URL with the header Authorization: Bearer <key>.">
            <CopyBox text={hermesSnippet(data.mcpUrl, created.token)} rows={6} />
          </Field>
          <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>Done</Button>
        </div>
      )}

      {form ? (
        <form onSubmit={create} className="space-y-3 rounded-2xl border border-line p-4">
          <Field label="Agent name"><input className={inputClass} autoFocus maxLength={60} placeholder="e.g. Mia poster" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Allowed to"><Access perms={form.perms} workspaceIds={form.workspaceIds} onChange={patch => setForm({ ...form, ...patch })} /></Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy} disabled={!form.name.trim() || (form.workspaceIds !== null && !form.workspaceIds.length)}>Create key</Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button onClick={() => { setCreated(null); setForm({ name: '', perms: DEFAULT_PERMS, workspaceIds: null }); }}><Plus className="size-4" />New agent key</Button>
      )}

      {data.agents.length > 0 && (
        <div className="space-y-2">
          {data.agents.map(agent => (
            <div key={agent.id} className="space-y-3 rounded-2xl border border-line p-4">
              <div className="flex items-start gap-3">
                <Bot className="mt-0.5 size-5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{agent.name}</div>
                  <div className="text-xs text-faint">Key …{agent.last4} · last used {when(agent.lastUsedAt)} · created {when(agent.createdAt)}</div>
                </div>
                <button onClick={() => remove(agent)} aria-label={`Delete ${agent.name}`} title="Delete key"
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger/15 hover:text-danger">
                  <Trash2 className="size-4" />
                </button>
              </div>
              <Access perms={agent.perms} workspaceIds={agent.workspaceIds} onChange={patch => update(agent.id, patch)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
