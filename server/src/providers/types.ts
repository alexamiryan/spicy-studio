export type Modality = 'image' | 'video';
export type MediaKind = 'image' | 'video' | 'audio';

/** One user-editable setting, normalized from whatever schema format a provider uses. */
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
  /** Display names for option values, e.g. { "-1": "Smart" }. */
  optionLabels?: Record<string, string>;
  /** Unit suffix for values, e.g. "s". */
  unit?: string;
  /** Less common setting: tucked behind "More" in the create box. */
  advanced?: boolean;
  placeholder?: string;
}

/** An input that takes reference media (uploaded or generated files). */
export interface RefField {
  key: string;
  label: string;
  kind: MediaKind;
  max: number;
  required: boolean;
  description?: string;
  /** The model's main reference input (numbered @image1… mentions and @elements go here). */
  primary?: boolean;
  /** The provider expects a list even when only one item is allowed. */
  array?: boolean;
}

export interface ModelInfo {
  /** Namespaced id: `${providerId}:${model}` */
  id: string;
  providerId: string;
  model: string;
  name: string;
  vendor?: string;
  modality: Modality;
  description?: string;
  /** Name of the prompt field, if the model takes one. */
  promptField?: string;
  fields: ModelField[];
  refFields: RefField[];
  /** The provider takes @elements itself (named subjects), instead of their images being attached as references. */
  nativeElements?: NativeElements;
  price?: string;
  available: boolean;
}

export interface NativeElements {
  /** Most elements per generation. */
  max: number;
  minImages: number;
  maxImages: number;
  /** A reference input that must be filled for elements to be used (e.g. Kling 3.0's start frame on Higgsfield). */
  requiresRef?: string;
  /** A setting value elements only work with (e.g. Kling O3 on SpicyAPI: resolution 4k). */
  requiresSetting?: { key: string; value: string | number };
  note?: string;
}

/** An @element passed to a provider that handles elements natively. */
export interface ElementInput {
  id: string;
  name: string;
  description: string;
  images: { uri: string; url?: string; file: string }[];
}

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface TaskResult {
  state: TaskState;
  error?: string;
  cost?: number;
  assets: { url: string; mime?: string; remoteRef?: string }[];
}

export interface CreateRequest {
  model: string;
  modality: Modality;
  prompt?: string;
  promptField?: string;
  settings: Record<string, unknown>;
  /** Provider URIs per ref field key, in order. */
  refs: Record<string, string[]>;
  /** @elements used in the prompt, for models with nativeElements (the prompt keeps `@name`). */
  elements?: ElementInput[];
  idempotencyKey: string;
  /** Pricing only: nothing may be created on the provider's side. */
  quote?: boolean;
}

export interface Cost { amount: number; unit: string }

export interface Balance { amount: number; unit: string; detail?: string }

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  authType: 'apiKey' | 'oauth';
  enabled: boolean;
  detail?: string;
}

export interface Provider {
  id: string;
  name: string;
  authType: 'apiKey' | 'oauth';
  unit: string;
  configured(): Promise<boolean>;
  listModels(modality: Modality): Promise<ModelInfo[]>;
  getModel(model: string): Promise<ModelInfo>;
  quote(req: CreateRequest): Promise<Cost | null>;
  /** Upload a local file; returns a value usable in `CreateRequest.refs`. */
  upload(filePath: string, mime: string, filename: string): Promise<{ uri: string; expiresAt?: Date; url?: string }>;
  create(req: CreateRequest): Promise<{ taskId: string; state: TaskState; estimatedCost?: number }>;
  task(taskId: string): Promise<TaskResult>;
  balance?(): Promise<Balance>;
}

export class ProviderError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

/** Settings the app never shows (the model picks them). */
export const HIDDEN_SETTINGS = /^(random_)?seed$/i;

export function humanize(key: string) {
  const text = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
