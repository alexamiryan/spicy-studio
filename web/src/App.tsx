import { RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { queryClient, startLiveUpdates, useAuth, useMySettings, useProviders, useWorkspaces } from './lib/queries';
import { useStore } from './lib/store';
import { startUpdateChecks, useUpdateAvailable } from './lib/update';
import { CreateBox } from './components/create/CreateBox';
import { FolderSidebar, Gallery } from './components/Gallery';
import { GenerationModal } from './components/GenerationModal';
import { Header } from './components/Header';
import { Library } from './components/Library';
import { Login } from './components/Login';
import { MoveSheet } from './components/MoveSheet';
import { RefPicker } from './components/RefPicker';
import { SettingsModal } from './components/SettingsModal';
import { Viewer } from './components/Viewer';
import { WorkspaceModal } from './components/WorkspaceModal';
import { Spinner, Toasts } from './components/ui';

/** New accounts: point at Settings until a provider and a save location are set up. */
function SetupBanner({ userId }: { userId: string }) {
  const set = useStore(s => s.set);
  const { data: providers } = useProviders();
  const { data: settings } = useMySettings();
  const key = `setupDismissed:${userId}`;
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  if (!providers || !settings || dismissed) return null;
  const needsProvider = !providers.some(p => p.configured);
  const needsSave = !settings.saveTarget;
  if (!needsProvider && !needsSave) return null;
  const tab = needsProvider ? 'providers' : 'save';
  const text = needsProvider && needsSave ? 'Connect a provider and choose where Save puts your files.'
    : needsProvider ? 'Connect a provider (SpicyAPI key or Higgsfield) to start generating.'
    : 'Choose where Save puts your files (a NAS share or a server folder).';
  return (
    <div className="mx-3 mt-3 flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/10 p-3 text-sm md:mx-4">
      <Sparkles className="size-5 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">{text}</span>
      <button onClick={() => set({ modal: { type: 'settings', tab } })} className="shrink-0 rounded-xl bg-accent px-3 py-2 font-semibold text-accent-fg">Set up</button>
      <button aria-label="Dismiss" onClick={() => { setDismissed(true); try { localStorage.setItem(key, '1'); } catch { /* private mode */ } }}
        className="flex size-9 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-white/8 hover:text-fg"><X className="size-4" /></button>
    </div>
  );
}

/** Shown when the server runs a newer version than this tab (e.g. a home-screen app left open). */
function UpdateBar() {
  const available = useUpdateAvailable();
  const [hidden, setHidden] = useState(false);
  if (!available || hidden) return null;
  return (
    <div className="pt-safe fixed inset-x-0 top-0 z-[60] flex justify-center px-3 pointer-events-none">
      <div className="pointer-events-auto mt-2 flex items-center gap-2 rounded-2xl border border-accent/40 bg-panel-2 py-1.5 pl-4 pr-1.5 text-sm shadow-xl">
        <span>New version available</span>
        <button onClick={() => window.location.reload()}
          className="flex h-9 items-center gap-1.5 rounded-xl bg-accent px-3 font-semibold text-accent-fg">
          <RefreshCw className="size-4" />Refresh
        </button>
        <button aria-label="Later" title="Later" onClick={() => setHidden(true)}
          className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-white/8 hover:text-fg"><X className="size-4" /></button>
      </div>
    </div>
  );
}

function Studio({ username, userId }: { username?: string; userId: string }) {
  const { data: workspaces } = useWorkspaces();
  const { workspaceId, setWorkspace, set, toast } = useStore();

  useEffect(() => {
    if (workspaces?.length && !workspaces.some(w => w.id === workspaceId)) setWorkspace(workspaces[0].id);
  }, [workspaces, workspaceId, setWorkspace]);

  useEffect(() => startLiveUpdates(), []);
  useEffect(() => startUpdateChecks(), []);

  // Return from the Higgsfield OAuth redirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('settings')) return;
    if (params.get('connected')) toast(`${params.get('connected') === 'higgsfield' ? 'Higgsfield' : 'Provider'} connected`);
    if (params.get('error')) toast(params.get('error')!, 'error');
    set({ modal: { type: 'settings', tab: 'providers' } });
    window.history.replaceState(null, '', '/');
  }, []);

  if (!workspaceId || !workspaces?.some(w => w.id === workspaceId)) {
    return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  }

  return (
    <div className="min-h-full">
      <UpdateBar />
      <Header username={username} />
      <SetupBanner userId={userId} />
      <div className="flex">
        <FolderSidebar />
        <Gallery key={workspaceId} />
      </div>
      <CreateBox />
      <Viewer />
      <RefPicker />
      <MoveSheet />
      <Library />
      <SettingsModal />
      <WorkspaceModal />
      <GenerationModal />
    </div>
  );
}

export function App() {
  const status = useAuth();
  // Another account may sign in next: forget everything cached for the previous one.
  const reset = () => {
    queryClient.removeQueries({ predicate: query => query.queryKey[0] !== 'auth' });
    return status.refetch();
  };

  useEffect(() => {
    const onSignedOut = () => reset();
    window.addEventListener('studio:signed-out', onSignedOut);
    return () => window.removeEventListener('studio:signed-out', onSignedOut);
  }, [status]);

  let content;
  if (status.isLoading) content = <div className="flex h-full items-center justify-center"><Spinner /></div>;
  else if (status.isError) content = <div className="flex h-full items-center justify-center p-6 text-center text-muted">Cannot reach the server. Is it running?</div>;
  else if (!status.data?.signedIn) content = <Login setup={Boolean(status.data?.needsSetup)} onDone={() => reset()} />;
  else content = <Studio key={status.data.userId} username={status.data.username} userId={status.data.userId!} />;

  return <>{content}<Toasts /></>;
}
