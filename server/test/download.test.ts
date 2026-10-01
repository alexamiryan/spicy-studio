import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'studio-dl-'));
const { storeFromUrl } = await import('../src/services/media.js');

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000' });
    if (req.url === '/stall') { res.write(Buffer.alloc(100)); return; } // sends a little, then goes silent
    res.end(Buffer.alloc(1000, 7));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

describe('storeFromUrl', () => {
  it('gives up on a stalled download instead of hanging', async () => {
    const started = Date.now();
    await expect(storeFromUrl(`${base}/stall`, 'image/png', 300)).rejects.toThrow(/stalled/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stores a normal download', async () => {
    const stored = await storeFromUrl(`${base}/ok`, 'image/png', 300);
    expect(stored.file).toMatch(/\.png$/);
  });
});
