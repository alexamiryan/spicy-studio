import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { one } from '../db.js';
import { ProviderError } from '../providers/types.js';
import { ownRow } from './access.js';
import { absPath, storeStream } from './media.js';

const run = promisify(execFile);
export const MIN_LENGTH = 0.5;

/** A trim range in seconds, checked against the video's length. Exported for tests. */
export function cleanRange(start: unknown, end: unknown, duration: number | null) {
  const s = Math.max(0, Number(start));
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) throw new ProviderError('Choose where the clip starts and ends.', 400);
  const length = duration && duration > 0 ? duration : Infinity;
  const to = Math.min(e, length);
  if (to - s < MIN_LENGTH) throw new ProviderError(`The trimmed clip must be at least ${MIN_LENGTH} s long.`, 400);
  if (s === 0 && to >= length - 0.02) throw new ProviderError('That keeps the whole video. Move the start or the end first.', 400);
  return { start: Math.round(s * 1000) / 1000, end: Math.round(to * 1000) / 1000 };
}

/**
 * ffmpeg arguments for a frame-accurate cut. Re-encoding (rather than copying) is what makes the cut land on
 * the chosen frame instead of the nearest keyframe; CRF 16 keeps it visually lossless. Exported for tests.
 */
export function trimArgs(source: string, target: string, start: number, end: number) {
  return [
    '-v', 'error', '-y', '-ss', String(start), '-i', source, '-t', String(Math.round((end - start) * 1000) / 1000),
    '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', target,
  ];
}

/**
 * Trim a video result into a new result next to the original (same generation and folder; the original stays).
 * Returns the new asset row.
 */
export async function trimAsset(userId: string, assetId: string, start: unknown, end: unknown) {
  const asset = await ownRow(userId, 'assets', assetId);
  if (asset.kind !== 'video') throw new ProviderError('Only videos can be trimmed.', 400);
  const range = cleanRange(start, end, asset.duration == null ? null : Number(asset.duration));
  const target = path.join(os.tmpdir(), `trim-${randomUUID()}.mp4`);
  try {
    try { await run('ffmpeg', trimArgs(absPath(asset.file), target, range.start, range.end), { maxBuffer: 4 * 1024 * 1024 }); }
    catch (error: any) { throw new ProviderError(`Could not trim the video: ${String(error.stderr || error.message).trim().slice(0, 300)}`, 500); }
    const stored = await storeStream(createReadStream(target), 'video/mp4', 2 * 1024 * 1024 * 1024);
    // Right after the original in the timeline (1 µs newer, computed in SQL: JS dates drop microseconds),
    // already seen: you made it just now.
    return one(
      `insert into assets (generation_id, workspace_id, folder_id, idx, kind, file, thumb, mime, width, height, duration, seen_at, created_at)
       select $1, $2, $3, coalesce(max(idx), 0) + 1, 'video', $4, $5, $6, $7, $8, $9, now(),
              (select created_at from assets where id = $10) + interval '1 microsecond'
         from assets where generation_id = $1
       returning *`,
      [asset.generation_id, asset.workspace_id, asset.folder_id, stored.file, stored.thumb, stored.mime,
        stored.width ?? asset.width, stored.height ?? asset.height, stored.duration ?? range.end - range.start, asset.id]);
  } finally {
    await rm(target, { force: true });
  }
}
