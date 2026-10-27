import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.ts';
import { hmac, safeEqual } from './crypto.ts';
import { one, q } from '../db/pool.ts';

/**
 * Private object storage. The default driver is the local filesystem, never served statically.
 * Every read goes through an authorization check and a short-lived signed URL.
 * Swap in an S3-compatible driver by implementing this interface (documented in docs/DEPLOYMENT.md).
 */
export interface Storage {
  put(key: string, data: Readable | Buffer): Promise<void>;
  open(key: string, range?: { start: number; end: number }): Readable;
  size(key: string): Promise<number>;
  remove(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  root: string;
  constructor(root: string) { this.root = resolve(root); mkdirSync(this.root, { recursive: true }); }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + '/')) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, data: Readable | Buffer) {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    if (Buffer.isBuffer(data)) { const ws = createWriteStream(p); await new Promise<void>((res, rej) => { ws.on('error', rej); ws.end(data, res); }); }
    else await pipeline(data, createWriteStream(p));
  }
  open(key: string, range?: { start: number; end: number }) { return createReadStream(this.path(key), range); }
  async size(key: string) { return (await stat(this.path(key))).size; }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}

/** Keeps media in PostgreSQL (MEDIA_STORE=db): survives redeploys on hosts with a temporary disk. Fine for demos and small installs. */
export class DbStorage implements Storage {
  async put(key: string, data: Readable | Buffer) {
    const chunks: Buffer[] = []; if (!Buffer.isBuffer(data)) for await (const c of data) chunks.push(Buffer.from(c));
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(chunks);
    await q(`insert into media_blobs(key, data) values ($1,$2) on conflict (key) do update set data = excluded.data`, [key, buf]);
  }
  open(key: string, range?: { start: number; end: number }) {
    return Readable.from((async function* () {
      const r = range ? await one(`select substring(data from $2::int for $3::int) as d from media_blobs where key = $1`, [key, range.start + 1, range.end - range.start + 1])
        : await one(`select data as d from media_blobs where key = $1`, [key]);
      if (!r) throw new Error('not_found');
      yield r.d as Buffer;
    })());
  }
  async size(key: string) { const r = await one(`select length(data) as n from media_blobs where key = $1`, [key]); if (!r) throw new Error('not_found'); return Number(r.n); }
  async remove(key: string) { await q(`delete from media_blobs where key = $1`, [key]); }
}

export const storage: Storage = config.mediaStore === 'db' ? new DbStorage() : new LocalStorage(config.mediaDir);

const TTL_SECONDS = 300;
export function signMediaUrl(mediaId: string, userId: string, thumb = false) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const t = thumb ? 1 : 0;
  const sig = hmac(config.urlSigningSecret, `${mediaId}.${userId}.${exp}.${t}`);
  return { url: `/api/media/${mediaId}/content?u=${userId}&e=${exp}&t=${t}&s=${sig}`, expiresAt: exp * 1000 };
}
export function verifyMediaSig(mediaId: string, userId: string, exp: number, t: number, sig: string) {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(hmac(config.urlSigningSecret, `${mediaId}.${userId}.${exp}.${t}`), sig);
}
