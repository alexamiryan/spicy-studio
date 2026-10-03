export type Modality = 'image' | 'video';
export type MediaKind = 'image' | 'video' | 'audio';

export interface ModelField {
  key: string;
  label: string;
  type: 'enum' | 'string' | 'text' | 'number' | 'integer' | 'boolean';
  options?: (string | number)[];
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  description?: string;
  optionLabels?: Record<string, string>;
  unit?: string;
  advanced?: boolean;
  placeholder?: string;
}

export interface RefField { key: string; label: string; kind: MediaKind; max: number; required: boolean; description?: string; primary?: boolean }

export interface ModelInfo {
  id: string;
  providerId: string;
  model: string;
  name: string;
  vendor?: string;
  modality: Modality;
  description?: string;
  promptField?: string;
  fields: ModelField[];
  refFields: RefField[];
  /** The provider takes @elements itself (as named subjects) instead of attached reference images. */
  nativeElements?: { max: number; minImages: number; maxImages: number; requiresRef?: string; note?: string };
  price?: string;
  available: boolean;
}

export interface ProviderStatus {
  id: string;
  name: string;
  authType: 'apiKey' | 'oauth';
  unit: string;
  configured: boolean;
  enabled: boolean;
  detail?: string;
}

export interface ModelGroup extends ProviderStatus { models: ModelInfo[]; error?: string }

export interface Workspace {
  id: string;
  name: string;
  imageExportDir: string;
  videoExportDir: string;
  prefs: { folderId?: string | null; imageModel?: string; videoModel?: string };
  createdAt: string;
}

export interface Folder { id: string; name: string; count: number; updatedAt: string; coverUrl: string | null }

export interface Ref {
  id: string;
  workspaceId: string;
  kind: MediaKind;
  name: string;
  mime: string;
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  isModelRef: boolean;
  sourceAssetId: string | null;
  sourceEnvironmentId?: string | null;
  createdAt: string;
}

/** A saved create-box state, per workspace and photo/video. */
export interface Preset {
  id: string;
  workspaceId: string;
  modality: Modality;
  name: string;
  modelId: string;
  prompt: string;
  settings: Record<string, unknown>;
  refSlots: Record<string, string[]>;
  refs: Ref[];
  folderId: string | null;
  batch: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** A photo in the user's environment library (shared by all their workspaces). */
export interface Environment {
  id: string;
  kind: MediaKind;
  name: string;
  mime: string;
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface Asset {
  id: string;
  generationId: string;
  workspaceId: string;
  folderId: string | null;
  index: number;
  kind: MediaKind;
  mime: string;
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  exported: boolean;
  /** Opened in the viewer at least once. */
  seen: boolean;
  createdAt: string;
  prompt: string;
  modelName: string;
  modelId?: string;
  providerId: string;
}

export interface Generation {
  id: string;
  workspaceId: string;
  folderId: string | null;
  providerId: string;
  modelId: string;
  modelName: string;
  modality: Modality;
  prompt: string;
  settings: Record<string, unknown>;
  refSlots: Record<string, string[]>;
  batchGroup: string;
  batchSize: number;
  status: 'pending' | 'queued' | 'running' | 'saving' | 'succeeded' | 'failed';
  error: string | null;
  estimatedCost: number | null;
  cost: number | null;
  costUnit: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationDetail extends Generation {
  /** Auto-routed: what actually ran (modelId/settings/refSlots above are what was picked: the Auto model). */
  routed?: { modelId: string; modelName: string; settings: Record<string, unknown>; refSlots: Record<string, string[]> };
  resolvedPrompt?: string;
  refs: Ref[];
  assets: Asset[];
  folder: { id: string; name: string } | null;
  /** What the user wrote, when the prompt was rewritten by the prompt assistant. */
  originalPrompt?: string;
  /** Made by an agent (API key) rather than in the studio. */
  agentName?: string;
}

export interface Element { id: string; name: string; description: string; createdAt: string; refs: Ref[] }

export interface Balance { providerId: string; name: string; amount: number | null; unit: string; detail?: string; error?: string }

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface Session { id: string; device: string; createdAt: string; lastSeen: string; current: boolean }

export interface AuthStatus { needsSetup: boolean; signedIn: boolean; username?: string; role?: 'admin' | 'user'; userId?: string }

export type SaveTargetForm =
  | { type: 'local'; path: string }
  | { type: 'smb'; host: string; share: string; path: string; username: string; domain?: string; hasPassword?: boolean; password?: string };

export interface MySettings { stripMetadata: boolean; saveTarget: SaveTargetForm | null; saveLabel: string; exportRoot: string }

export interface AdminUser {
  id: string; username: string; role: 'admin' | 'user'; createdAt: string; workspaces: number; results: number; lastSeen: string | null;
}
