import type { ModelField, ModelInfo, Ref, RefField } from './types';

export function primaryRefField(model?: ModelInfo | null): RefField | undefined {
  if (!model) return undefined;
  return model.refFields.find(f => f.primary && f.kind === 'image') || model.refFields.find(f => f.kind === 'image' && f.max > 1) || model.refFields.find(f => f.kind === 'image');
}

export function defaultSettings(model: ModelInfo, previous: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const field of model.fields) {
    const prev = previous[field.key];
    if (prev !== undefined && valid(field, prev)) out[field.key] = prev;
    else if (field.default !== undefined && field.default !== null) out[field.key] = field.default;
  }
  return out;
}

function valid(field: ModelField, value: unknown) {
  if (field.type === 'enum') return field.options?.some(o => String(o) === String(value)) ?? false;
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (field.type === 'number') return typeof value === 'number';
  return typeof value === 'string';
}

/** Carry selected references over to a newly selected model's fields. */
export function remapRefs(slots: Record<string, Ref[]>, model: ModelInfo): Record<string, Ref[]> {
  const out: Record<string, Ref[]> = {};
  const used = new Set<string>();
  for (const field of model.refFields) {
    const same = (slots[field.key] || []).filter(r => r.kind === field.kind).slice(0, field.max);
    out[field.key] = same;
    same.forEach(r => used.add(r.id));
  }
  const primary = primaryRefField(model);
  if (primary) {
    const leftovers = Object.values(slots).flat().filter(r => r.kind === 'image' && !used.has(r.id));
    out[primary.key] = [...out[primary.key], ...leftovers].slice(0, primary.max);
  }
  return out;
}

export function formatCost(amount: number | null | undefined, unit?: string | null) {
  if (amount === null || amount === undefined) return '';
  if (unit === 'USD') return `$${amount < 0.1 ? amount.toFixed(3) : amount.toFixed(2)}`;
  return `${Number.isInteger(amount) ? amount : amount.toFixed(2)} ${unit === 'credits' ? 'cr' : unit || ''}`.trim();
}

export function formatBalance(amount: number | null, unit: string, compact = false) {
  if (amount === null) return '—';
  if (unit === 'USD') return `$${amount.toFixed(2)}`;
  const value = Math.round(amount * 100) / 100;
  return compact ? String(value) : `${value} cr`; // compact: header pill, where the provider name gives context
}

export function fieldDisplay(field: ModelField, value: unknown) {
  if (value === undefined || value === null || value === '') return 'Auto';
  if (field.type === 'boolean') return value ? 'On' : 'Off';
  const label = field.optionLabels?.[String(value)];
  if (label) return label;
  if (field.unit) return `${value}${field.unit}`;
  if (field.key === 'duration' || /seconds/.test(field.key)) return `${value}s`;
  return String(value);
}
