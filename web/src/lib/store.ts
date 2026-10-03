import { create } from 'zustand';
import type { Asset, Modality, Ref } from './types';

export interface Draft {
  modality: Modality;
  models: Partial<Record<Modality, string>>;
  /** Settings per model id, so switching models back and forth keeps choices. */
  settings: Record<string, Record<string, unknown>>;
  prompt: string;
  /** Selected references per ref-field key, in order. */
  refSlots: Record<string, Ref[]>;
  folderId: string | null;
  batch: number;
}

export const emptyDraft = (): Draft => ({ modality: 'image', models: {}, settings: {}, prompt: '', refSlots: {}, folderId: null, batch: 1 });

export type Modal =
  | { type: 'settings'; tab?: 'general' | 'auto' | 'save' | 'providers' | 'agents' | 'account' | 'users' }
  | { type: 'library'; tab?: 'refs' | 'environments' | 'elements' }
  | { type: 'workspace'; id?: string }
  | { type: 'refPicker'; fieldKey: string }
  | { type: 'move'; assetIds: string[] }
  | { type: 'generation'; id: string }
  | null;

export interface Toast { id: number; text: string; tone?: 'error' | 'ok' }

/** Result ids in the order the grid shows them (set by the grid; used for range selection). */
let gridOrder: string[] = [];
export const setGridOrder = (ids: string[]) => { gridOrder = ids; };
export const rangeGap = (selected: string[]) => {
  const positions = selected.map(id => gridOrder.indexOf(id)).filter(i => i >= 0);
  return positions.length >= 2 && Math.max(...positions) - Math.min(...positions) + 1 > positions.length;
};

interface State {
  workspaceId: string | null;
  /** The result clicked last while selecting: Shift+click selects from here. */
  selectAnchor: string | null;
  draft: Draft;
  view: 'timeline' | 'folders';
  folder: string | null; // null = folder grid (in folders view); 'unsorted' | folder id
  kind: 'all' | 'image' | 'video';
  selecting: boolean;
  selected: string[];
  viewer: { list: Asset[]; index: number } | null;
  modal: Modal;
  createOpen: boolean; // mobile create sheet
  /** The result last used for Recreate; the reference picker offers it first. */
  recreatedFrom: Asset | null;
  /** The generation Recreate is loading right now (one at a time). */
  recreating: string | null;
  /** The asset Animate is loading right now (one at a time). */
  animating: string | null;
  /**
   * The preset last loaded or saved per modality, with a snapshot of the create box at that moment:
   * a different box means the preset was edited (offered for update, never saved automatically).
   */
  activePreset: Partial<Record<Modality, { id: string; snapshot: string }>>;
  /** A multi-file upload in progress (shown as a progress pill). */
  upload: { done: number; total: number; label: string } | null;
  toasts: Toast[];
  setWorkspace: (id: string) => void;
  patchDraft: (patch: Partial<Draft>) => void;
  setDraft: (draft: Draft) => void;
  set: (patch: Partial<Omit<State, 'draft'>>) => void;
  toggleSelect: (id: string) => void;
  /** Select everything between the last clicked result and this one (in grid order). */
  selectRangeTo: (id: string) => void;
  /** Select everything between the first and last selected results (in grid order). */
  fillRange: () => void;
  clearSelection: () => void;
  toast: (text: string, tone?: Toast['tone']) => void;
}

const draftKey = (ws: string) => `studio:draft:${ws}`;
const uiKey = 'studio:ui';

function loadDraft(ws: string): Draft {
  try {
    const raw = localStorage.getItem(draftKey(ws));
    if (raw) return { ...emptyDraft(), ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return emptyDraft();
}

function loadUi(): Partial<State> {
  try { return JSON.parse(localStorage.getItem(uiKey) || '{}'); } catch { return {}; }
}

let toastId = 0;
const ui = loadUi();

export const useStore = create<State>((set, get) => ({
  workspaceId: (ui.workspaceId as string) || null,
  draft: ui.workspaceId ? loadDraft(ui.workspaceId as string) : emptyDraft(),
  view: (ui.view as State['view']) || 'timeline',
  // The open folder survives a reload (a folder deleted meanwhile falls back to the folder grid).
  folder: (ui.view === 'folders' && typeof ui.folder === 'string' && ui.folder) || null,
  kind: (ui.kind as State['kind']) || 'all',
  selecting: false,
  selected: [],
  viewer: null,
  modal: null,
  createOpen: false,
  recreatedFrom: null,
  recreating: null,
  animating: null,
  selectAnchor: null,
  upload: null,
  activePreset: {},
  toasts: [],
  setWorkspace: id => {
    if (get().workspaceId === id) return;
    set({ workspaceId: id, draft: loadDraft(id), folder: null, selected: [], selecting: false, viewer: null, activePreset: {} });
  },
  patchDraft: patch => set(s => ({ draft: { ...s.draft, ...patch } })),
  setDraft: draft => set({ draft }),
  set: patch => set(patch as Partial<State>),
  toggleSelect: id => set(s => ({ selected: s.selected.includes(id) ? s.selected.filter(x => x !== id) : [...s.selected, id], selectAnchor: id })),
  selectRangeTo: id => set(s => {
    const from = s.selectAnchor ? gridOrder.indexOf(s.selectAnchor) : -1;
    const to = gridOrder.indexOf(id);
    if (from < 0 || to < 0) return { selected: s.selected.includes(id) ? s.selected : [...s.selected, id], selectAnchor: id };
    const range = gridOrder.slice(Math.min(from, to), Math.max(from, to) + 1);
    return { selected: [...s.selected, ...range.filter(x => !s.selected.includes(x))], selectAnchor: id };
  }),
  fillRange: () => set(s => {
    const positions = s.selected.map(id => gridOrder.indexOf(id)).filter(i => i >= 0);
    if (positions.length < 2) return {};
    const range = gridOrder.slice(Math.min(...positions), Math.max(...positions) + 1);
    return { selected: [...s.selected, ...range.filter(x => !s.selected.includes(x))] };
  }),
  clearSelection: () => set({ selected: [], selecting: false, selectAnchor: null }),
  toast: (text, tone) => {
    const id = ++toastId;
    set(s => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), tone === 'error' ? 6000 : 3500);
  },
}));

// Persist the draft per workspace and a few UI prefs.
let saveTimer: number | undefined;
useStore.subscribe(state => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      if (state.workspaceId) localStorage.setItem(draftKey(state.workspaceId), JSON.stringify(state.draft));
      localStorage.setItem(uiKey, JSON.stringify({ workspaceId: state.workspaceId, view: state.view, folder: state.folder, kind: state.kind }));
    } catch { /* storage full or blocked */ }
  }, 300);
});

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
