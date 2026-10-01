import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProviderError } from '../providers/types.js';

const run = promisify(execFile);

/*
 * Lossless metadata removal: image data is copied byte-for-byte, only metadata containers are dropped.
 * Colour information (ICC profiles, gamma, etc.) is kept so images look the same.
 */

/** JPEG: keep APP0 (JFIF), APP2 ICC profile and APP14 (Adobe colour transform); drop other APPn and comments. */
export function stripJpeg(input: Buffer): Buffer {
  if (input[0] !== 0xff || input[1] !== 0xd8) throw new ProviderError('Not a JPEG file.', 400);
  const parts: Buffer[] = [input.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= input.length) {
    if (input[i] !== 0xff) throw new ProviderError('Corrupt JPEG file.', 400);
    const marker = input[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xda) { parts.push(input.subarray(i)); break; } // start of scan: rest is image data
    if (marker === 0xd9) { parts.push(input.subarray(i, i + 2)); break; }
    const length = input.readUInt16BE(i + 2);
    const segment = input.subarray(i, i + 2 + length);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keepApp = marker === 0xe0 || marker === 0xee || (marker === 0xe2 && segment.subarray(4, 15).toString('latin1') === 'ICC_PROFILE');
    if ((!isApp || keepApp) && marker !== 0xfe) parts.push(segment);
    i += 2 + length;
  }
  return Buffer.concat(parts);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT']);

/** PNG: keep image and colour chunks; drop text (tEXt/zTXt/iTXt), eXIf, tIME, C2PA (caBX) and anything else. */
export function stripPng(input: Buffer): Buffer {
  if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) throw new ProviderError('Not a PNG file.', 400);
  const parts: Buffer[] = [PNG_SIGNATURE];
  let i = 8;
  while (i + 12 <= input.length) {
    const length = input.readUInt32BE(i);
    const type = input.subarray(i + 4, i + 8).toString('latin1');
    const chunk = input.subarray(i, i + 12 + length);
    if (PNG_KEEP.has(type)) parts.push(chunk);
    i += 12 + length;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

/** WebP: drop EXIF, XMP and other non-image chunks, and clear the matching VP8X flags. */
export function stripWebp(input: Buffer): Buffer {
  if (input.subarray(0, 4).toString('latin1') !== 'RIFF' || input.subarray(8, 12).toString('latin1') !== 'WEBP') {
    throw new ProviderError('Not a WebP file.', 400);
  }
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= input.length) {
    const type = input.subarray(i, i + 4).toString('latin1');
    const size = input.readUInt32LE(i + 4);
    const padded = size + (size % 2);
    if (WEBP_KEEP.has(type)) {
      const chunk = Buffer.from(input.subarray(i, i + 8 + padded));
      if (type === 'VP8X') chunk[8] &= ~(0x08 | 0x04); // EXIF and XMP present flags
      chunks.push(chunk);
    }
    i += 8 + padded;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/** Returns stripped bytes for supported image types, or null when the type isn't handled here. */
export function stripImage(input: Buffer, mime: string): Buffer | null {
  if (mime === 'image/jpeg') return stripJpeg(input);
  if (mime === 'image/png') return stripPng(input);
  if (mime === 'image/webp') return stripWebp(input);
  return null;
}

/** Videos: rewrite the container without global/stream metadata or chapters. No re-encode. */
export async function stripVideo(source: string, target: string) {
  try {
    await run('ffmpeg', [
      '-v', 'error', '-y', '-i', source, '-map', '0', '-map_metadata', '-1', '-map_chapters', '-1',
      '-c', 'copy', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', target,
    ]);
  } catch (error: any) {
    throw new ProviderError(`Could not remove video metadata: ${String(error.stderr || error.message).trim().slice(0, 300)}`, 500);
  }
}
