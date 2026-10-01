import { useInfiniteQuery, useQuery, QueryClient } from '@tanstack/react-query';
import { api, qs } from './api';
import { checkForUpdate } from './update';
import type {
  AuthStatus, MySettings, Asset, Balance, Element, Folder, Generation, Modality, ModelGroup, Page, ProviderStatus, Ref, Session, Workspace, Environment,
} from './types';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

export const keys = {
  workspaces: ['workspaces'] as const,
  folders: (ws: string) => ['folders', ws] as const,
  assets: (ws: string) => ['assets', ws] as const,
  refs: (ws: string) => ['refs', ws] as const,
  elements: (ws: string) => ['elements', ws] as const,
  active: (ws: string) => ['active', ws] as const,
  models: (m: Modality) => ['models', m] as const,
  balances: ['balances'] as const,
  providers: ['providers'] as const,
  environments: ['environments'] as const,
};

export const useWorkspaces = () => useQuery({ queryKey: keys.workspaces, queryFn: () => api.get<Workspace[]>('/api/workspaces') });

export const useFolders = (ws: string | null) => useQuery({
  queryKey: keys.folders(ws || ''), enabled: Boolean(ws),
  queryFn: () => api.get<{ folders: Folder[]; unsorted: Omit<Folder, 'id' | 'name'> }>(`/api/workspaces/${ws}/folders`),
});

export const useModels = (modality: Modality) => useQuery({
  queryKey: keys.models(modality), staleTime: 60_000,
  queryFn: () => api.get<{ providers: ModelGroup[]; favorites: string[] }>(`/api/models?modality=${modality}`),
});

export const useElements = (ws: string | null) => useQuery({
  queryKey: keys.elements(ws || ''), enabled: Boolean(ws), queryFn: () => api.get<Element[]>(`/api/elements?workspaceId=${ws}`),
});

export const useBalances = () => useQuery({
  queryKey: keys.balances, refetchInterval: 60_000, staleTime: 20_000, queryFn: () => api.get<Balance[]>('/api/balances'),
});

export const useProviders = () => useQuery({ queryKey: keys.providers, queryFn: () => api.get<ProviderStatus[]>('/api/providers') });

export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => api.get<Session[]>('/api/auth/sessions') });

export const useActive = (ws: string | null) => useQuery({
  queryKey: keys.active(ws || ''), enabled: Boolean(ws),
  queryFn: () => api.get<Generation[]>(`/api/generations/active?workspaceId=${ws}`),
  refetchInterval: q => (q.state.data?.some(g => g.status !== 'failed') ? 2500 : false),
});

export const useAssets = (ws: string | null, folder: string, kind: string) => useInfiniteQuery({
  queryKey: [...keys.assets(ws || ''), folder, kind],
  enabled: Boolean(ws),
  initialPageParam: '' as string,
  queryFn: ({ pageParam }) => api.get<Page<Asset>>(`/api/assets?${qs({ workspaceId: ws, folder, kind: kind === 'all' ? '' : kind, cursor: pageParam, limit: 60 })}`),
  getNextPageParam: last => last.nextCursor || undefined,
});

export const useRefs = (ws: string | null, tab: string, kind?: string) => useInfiniteQuery({
  queryKey: [...keys.refs(ws || ''), tab, kind || ''],
  enabled: Boolean(ws),
  initialPageParam: '' as string,
  queryFn: ({ pageParam }) => api.get<Page<Ref>>(`/api/refs?${qs({ workspaceId: ws, tab, kind, cursor: pageParam, limit: 60 })}`),
  getNextPageParam: last => last.nextCursor || undefined,
});

export const useEnvironments = (enabled = true) => useInfiniteQuery({
  queryKey: keys.environments,
  enabled,
  initialPageParam: '' as string,
  queryFn: ({ pageParam }) => api.get<Page<Environment>>(`/api/environments?${qs({ cursor: pageParam, limit: 60 })}`),
  getNextPageParam: last => last.nextCursor || undefined,
});

export function invalidateGallery(ws: string) {
  queryClient.invalidateQueries({ queryKey: keys.assets(ws) });
  queryClient.invalidateQueries({ queryKey: keys.folders(ws) });
}

// Queries that are expensive or don't reflect shared data; everything else refreshes on live events.
const NOT_LIVE = new Set(['models', 'quote', 'config', 'auth']);
let liveTimer: number | undefined;
function refreshLive() {
  window.clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => {
    // Only mounted (active) queries refetch; the rest are marked stale.
    queryClient.invalidateQueries({ predicate: q => !NOT_LIVE.has(String(q.queryKey[0])) });
  }, 200);
}

/**
 * Keep every open tab in sync with the server: a Server-Sent Events stream announces changes made
 * anywhere (another device, the background worker). When a tab comes back to the foreground or the
 * stream reconnects (phones drop it in the background), it catches up.
 */
export function startLiveUpdates() {
  let source: EventSource | null = null;
  const connect = () => {
    source?.close();
    source = new EventSource('/api/events');
    source.addEventListener('change', refreshLive);
    source.addEventListener('open', refreshLive);
    source.addEventListener('open', () => checkForUpdate()); // the server restarts on every update
  };
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (!source || source.readyState === EventSource.CLOSED) connect();
    refreshLive();
  };
  connect();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
  return () => {
    source?.close();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onVisible);
  };
}

export const useAuth = () => useQuery({
  queryKey: ['auth'], staleTime: Infinity,
  queryFn: () => api.get<AuthStatus>('/api/auth/status'),
});

export const useMySettings = () => useQuery({ queryKey: ['mySettings'], queryFn: () => api.get<MySettings>('/api/me/settings') });

/** Full save folder for a workspace dir, e.g. "\\\\192.168.1.10\\ai\\Pictures\\Mia\\images" ('' when no save location is set). */
export function saveFolderLabel(base: string | undefined, dir: string) {
  if (!base) return '';
  const smb = base.startsWith('\\\\');
  const root = base.replace(/[\\/]+$/, '');
  return smb ? `${root}\\${dir.replace(/\//g, '\\')}` : `${root}/${dir}`;
}
