import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ProviderError } from '../providers/types.js';
import { absPath } from './media.js';
import { stripImage, stripVideo } from './metadata.js';

/** Normalize a user-entered relative folder like "mia/images" into a safe relative path. */
export function sanitizeRelativeDir(value: string): string {
  const raw = String(value || '').split(/[\\/]+/).map(p => p.trim());
  if (raw.some(p => /^\.{2,}$/.test(p))) throw new ProviderError('Export folder must stay inside the export root.', 400);
  const parts = raw
    .map(p => p.replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/^\.$/, '').replace(/[. ]+$/, ''))
    .filter(Boolean);
  if (!parts.length) throw new ProviderError('Choose an export folder name.', 400);
  return parts.join('/');
}

export function resolveInside(root: string, rel: string) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, rel);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new ProviderError('Export folder must stay inside the export root.', 400);
  }
  return target;
}

export function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
}

export function stamp(date: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** File name used for a saved result, e.g. 20260930_143012_seedream-4-5_1.png */
export const savedName = (createdAt: Date, modelName: string, index: number, ext: string) =>
  `${stamp(createdAt)}_${slug(modelName)}_${index + 1}${ext}`;

/** Write `file` to `target`, stripping metadata when asked (lossless for images, remux for video). */
export async function writeSaved(file: string, mime: string, target: string, stripMetadata: boolean) {
  if (!stripMetadata) await copyFile(absPath(file), target);
  else if (mime.startsWith('video/')) await stripVideo(absPath(file), target);
  else {
    const bytes = await readFile(absPath(file));
    await writeFile(target, stripImage(bytes, mime) ?? bytes);
  }
}

async function available(file: string) {
  const ext = path.extname(file);
  const base = file.slice(0, -ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? file : `${base}-${n}${ext}`;
    try { await stat(candidate); } catch { return candidate; }
  }
}

/** Save into a folder on the server's mounted export disk: <EXPORT_ROOT>/<base>/<relDir>/<name>. */
export async function saveLocal(opts: { base: string; file: string; mime: string; relDir: string; createdAt: Date; modelName: string; index: number; stripMetadata?: boolean }) {
  const root = opts.base ? resolveInside(config.exportRoot, sanitizeRelativeDir(opts.base)) : config.exportRoot;
  const dir = resolveInside(root, sanitizeRelativeDir(opts.relDir));
  await mkdir(dir, { recursive: true });
  const target = await available(path.join(dir, savedName(opts.createdAt, opts.modelName, opts.index, path.extname(opts.file))));
  await writeSaved(opts.file, opts.mime, target, Boolean(opts.stripMetadata));
  const relative = path.relative(config.exportRoot, target).split(path.sep).join('/');
  return { relative, display: `${config.exportRootLabel.replace(/[\/]+$/, '')}/${relative}` };
}
