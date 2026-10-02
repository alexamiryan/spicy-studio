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
  | { type: 'settings'; tab?: 'general' | 'save' | 'providers' | 'account' | 'users' }
  | { type: 'library'; tab?: 'refs' | 'environments' | 'elements' }
  | { type: 'workspace'; id?: string }
  | { type: 'refPicker'; fieldKey: string }
  | { type: 'move'; assetIds: string[] }
  | { type: 'generation'; id: string }
  | null;

export interface Toast { id: number; text: string; tone?: 'error' | 'ok' }

interface State {
  workspaceId: string | null;
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
  /** The preset last loaded or saved per modality (marked in the presets list). */
  activePreset: Partial<Record<Modality, string>>;
  /** A multi-file upload in progress (shown as a progress pill). */
  upload: { done: number; total: number; label: string } | null;
  toasts: Toast[];
  setWorkspace: (id: string) => void;
  patchDraft: (patch: Partial<Draft>) => void;
  setDraft: (draft: Draft) => void;
  set: (patch: Partial<Omit<State, 'draft'>>) => void;
  toggleSelect: (id: string) => void;
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
  folder: null,
  kind: (ui.kind as State['kind']) || 'all',
  selecting: false,
  selected: [],
  viewer: null,
  modal: null,
  createOpen: false,
  recreatedFrom: null,
  upload: null,
  activePreset: {},
  toasts: [],
  setWorkspace: id => {
    if (get().workspaceId === id) return;
    set({ workspaceId: id, draft: loadDraft(id), folder: null, selected: [], selecting: false, viewer: null });
  },
  patchDraft: patch => set(s => ({ draft: { ...s.draft, ...patch } })),
  setDraft: draft => set({ draft }),
  set: patch => set(patch as Partial<State>),
  toggleSelect: id => set(s => ({ selected: s.selected.includes(id) ? s.selected.filter(x => x !== id) : [...s.selected, id] })),
  clearSelection: () => set({ selected: [], selecting: false }),
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
      localStorage.setItem(uiKey, JSON.stringify({ workspaceId: state.workspaceId, view: state.view, kind: state.kind }));
    } catch { /* storage full or blocked */ }
  }, 300);
});

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
