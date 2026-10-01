import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { mediaDir } from '../config.js';
import { q } from '../db.js';
import { ProviderError } from '../providers/types.js';

const run = promisify(execFile);

export const MIME_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/heic': '.heic', 'image/heif': '.heif', 'image/avif': '.avif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
};
const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));

export function kindOf(mime: string): 'image' | 'video' | 'audio' {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'image';
}

export function mimeFromName(name: string) { return EXT_MIME[path.extname(name).toLowerCase()]; }

export interface StoredMedia {
  file: string;
  thumb: string | null;
  mime: string;
  kind: 'image' | 'video' | 'audio';
  width: number | null;
  height: number | null;
  duration: number | null;
}

/** Relative path for a content hash: `ab/abcdef…ext`, sharded to keep directories small. */
const relFor = (hash: string, ext: string) => `${hash.slice(0, 2)}/${hash}${ext}`;
export const absPath = (rel: string) => path.join(mediaDir(), rel);

/**
 * A plain grey image used only to price a generation before its image inputs are filled
 * (SpicyAPI won't quote without them; image content doesn't affect the price). Created once.
 */
export const QUOTE_PLACEHOLDER = 'placeholder/quote-reference.png';
export async function ensureQuotePlaceholder() {
  const file = absPath(QUOTE_PLACEHOLDER);
  if (await exists(file)) return QUOTE_PLACEHOLDER;
  await mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toFile(file);
  return QUOTE_PLACEHOLDER;
}

export const SAFE_MEDIA_PATH = /^[0-9a-f]{2}\/[0-9a-f]{64}(_t)?\.[a-z0-9]{2,5}$/;

async function exists(file: string) { try { await stat(file); return true; } catch { return false; } }

async function makeThumb(source: string, hash: string, kind: string): Promise<{ thumb: string | null; width: number | null; height: number | null; duration: number | null }> {
  const thumbRel = `${hash.slice(0, 2)}/${hash}_t.webp`;
  const thumbAbs = absPath(thumbRel);
  if (kind === 'image') {
    const meta = await sharp(source, { animated: false }).metadata();
    if (!(await exists(thumbAbs))) {
      await sharp(source, { animated: false }).rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(thumbAbs);
    }
    const rotated = (meta.orientation ?? 1) >= 5;
    return { thumb: thumbRel, width: (rotated ? meta.height : meta.width) ?? null, height: (rotated ? meta.width : meta.height) ?? null, duration: null };
  }
  if (kind === 'video') {
    let width: number | null = null, height: number | null = null, duration: number | null = null;
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', source]);
      const info = JSON.parse(stdout);
      width = info.streams?.[0]?.width ?? null;
      height = info.streams?.[0]?.height ?? null;
      duration = info.format?.duration ? Number(info.format.duration) : null;
      if (!(await exists(thumbAbs))) {
        const frame = `${thumbAbs}.${randomUUID()}.jpg`;
        await run('ffmpeg', ['-v', 'error', '-ss', duration && duration > 1 ? '0.5' : '0', '-i', source, '-frames:v', '1', '-y', frame]);
        await sharp(frame).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toFile(thumbAbs);
        await rm(frame, { force: true });
      }
      return { thumb: thumbRel, width, height, duration };
    } catch {
      // ffmpeg unavailable (e.g. local dev without it): the UI falls back to the video itself.
      return { thumb: null, width, height, duration };
    }
  }
  return { thumb: null, width: null, height: null, duration: null };
}

/** Stream bytes into the content-addressed store; returns metadata incl. thumbnail. */
export async function storeStream(source: Readable, mime: string, maxBytes = 200 * 1024 * 1024): Promise<StoredMedia> {
  let ext = MIME_EXT[mime];
  if (!ext) throw new ProviderError(`Unsupported file type ${mime}.`, 400);
  await mkdir(mediaDir(), { recursive: true });
  const temp = path.join(mediaDir(), `.upload-${randomUUID()}`);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) return done(new ProviderError('File is too large.', 413));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, createWriteStream(temp));
    if (!size) throw new ProviderError('The file is empty.', 400);
    let digest = hash.digest('hex');
    let kind = kindOf(mime);
    let tempPath = temp;
    // HEIC/HEIF/AVIF from phones: convert to JPEG so every provider and browser accepts it.
    if (['image/heic', 'image/heif', 'image/avif'].includes(mime)) {
      const converted = `${temp}.jpg`;
      try { await sharp(temp).rotate().jpeg({ quality: 92 }).toFile(converted); }
      catch { throw new ProviderError('This HEIC photo could not be converted. Share it as JPEG (iPhone: Settings → Camera → Formats → Most Compatible).', 400); }
      await rm(temp, { force: true });
      tempPath = converted;
      mime = 'image/jpeg';
      ext = '.jpg';
      digest = createHash('sha256').update(await readFile(converted)).digest('hex');
    }
    const rel = relFor(digest, ext);
    await mkdir(path.dirname(absPath(rel)), { recursive: true });
    if (await exists(absPath(rel))) await rm(tempPath, { force: true });
    else await rename(tempPath, absPath(rel));
    const meta = await makeThumb(absPath(rel), digest, kind).catch(() => ({ thumb: null, width: null, height: null, duration: null }));
    return { file: rel, mime, kind, ...meta };
  } catch (error) {
    await rm(temp, { force: true });
    await rm(`${temp}.jpg`, { force: true });
    throw error;
  }
}

export async function storeFromUrl(url: string, fallbackMime: string, stallMs = 30_000): Promise<StoredMedia> {
  // Only the development mock provider produces local files.
  if (url.startsWith('file://') && process.env.MOCK_PROVIDER === '1') return storeStream(createReadStream(url.slice(7)), fallbackMime);
  // A stalled connection is abandoned after 30s without data (and retried by the worker),
  // instead of hanging until one long overall timeout.
  const controller = new AbortController();
  const stall = () => controller.abort(new ProviderError(`The download stalled (no data for ${stallMs / 1000}s).`));
  let idle = setTimeout(stall, stallMs);
  const overall = setTimeout(() => controller.abort(new ProviderError('The download took longer than 15 minutes.')), 15 * 60_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new ProviderError(`Could not download result (HTTP ${response.status}).`);
    let mime = response.headers.get('content-type')?.split(';')[0].trim() || '';
    if (!MIME_EXT[mime]) mime = mimeFromName(new URL(url).pathname) || fallbackMime;
    const watchdog = new Transform({
      transform(chunk, _enc, done) { clearTimeout(idle); idle = setTimeout(stall, stallMs); done(null, chunk); },
    });
    const body = Readable.fromWeb(response.body as any);
    body.on('error', error => watchdog.destroy(controller.signal.aborted ? controller.signal.reason : error)); // .pipe() doesn't forward errors
    return await storeStream(body.pipe(watchdog), mime, 2 * 1024 * 1024 * 1024);
  } finally {
    clearTimeout(idle);
    clearTimeout(overall);
  }
}

export function openMedia(rel: string) { return createReadStream(absPath(rel)); }

/**
 * Re-encode an image so it fits under `maxBytes` (providers cap reference size). Returns the
 * original bytes when they already fit. Keeps transparency by using WebP for images with alpha,
 * JPEG otherwise; lowers quality first, then scales down until it fits.
 */
export async function fitImageUnder(input: Buffer, mime: string, maxBytes: number): Promise<{ bytes: Buffer; mime: string }> {
  if (input.length <= maxBytes || !mime.startsWith('image/')) return { bytes: input, mime };
  const meta = await sharp(input).metadata();
  const alpha = Boolean(meta.hasAlpha);
  const encode = (width: number | undefined, quality: number) => {
    const pipeline = sharp(input, { animated: false }).rotate();
    if (width) pipeline.resize({ width, withoutEnlargement: true });
    return alpha ? pipeline.webp({ quality }).toBuffer() : pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  };
  const outMime = alpha ? 'image/webp' : 'image/jpeg';
  for (const quality of [92, 85]) {
    const out = await encode(undefined, quality);
    if (out.length <= maxBytes) return { bytes: out, mime: outMime };
  }
  let width = meta.width || 4096;
  for (let i = 0; i < 12; i++) {
    width = Math.max(Math.round(width * 0.8), 256);
    const out = await encode(width, 88);
    if (out.length <= maxBytes) return { bytes: out, mime: outMime };
  }
  throw new ProviderError('Could not shrink this image under the provider size limit.', 400);
}

/** Delete files no longer referenced by any ref or asset. */
export async function collectGarbage(files: string[]) {
  for (const file of new Set(files)) {
    const [{ count }] = await q<{ count: number }>(
      'select (select count(*) from refs where file = $1) + (select count(*) from assets where file = $1) as count', [file]);
    if (count > 0) continue;
    await rm(absPath(file), { force: true });
    const thumb = file.replace(/\.[a-z0-9]+$/, '_t.webp');
    await rm(absPath(thumb), { force: true });
    await q('delete from provider_uploads where file = $1', [file]);
  }
}
