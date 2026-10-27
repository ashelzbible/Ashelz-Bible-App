import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/**
 * Album splitting: one long audio file in, a list of tracks out. Uses ffmpeg/ffprobe (installed in the Docker image).
 * Chapters are used when the file has them; otherwise tracks are found by looking for gaps of silence between songs.
 */
export const ALBUM_ROOT = join(tmpdir(), 'wz-album');
export const MAX_ALBUM_MS = 4 * 3600_000;
export interface Segment { startMs: number; endMs: number; title: string }
export interface AlbumInfo { durationMs: number; codec: string; album: string; artist: string; source: 'chapters' | 'silence' | 'single'; segments: Segment[] }

function run(cmd: string, args: string[], timeoutMs = 20 * 60_000): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > 5e6) out = out.slice(-5e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 5e6) err = err.slice(-5e6); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`)); });
  });
}
export async function ffmpegAvailable() { try { await run('ffprobe', ['-version'], 5000); return true; } catch { return false; } }

export async function saveUpload(id: string, stream: Readable): Promise<string> {
  const dir = join(ALBUM_ROOT, id); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'source');
  await pipeline(stream, createWriteStream(file));
  return file;
}

/** Pure helper: turns silence intervals into track boundaries. Tracks shorter than minMs are merged into the previous one. */
export function segmentsFromSilence(durationMs: number, silences: Array<{ start: number; end: number }>, minMs = 25_000): Array<{ startMs: number; endMs: number }> {
  const cuts = silences.map((s) => Math.round(((s.start + s.end) / 2) * 1000)).filter((c) => c > 0 && c < durationMs).sort((a, b) => a - b);
  const bounds = [0, ...cuts, durationMs]; const out: Array<{ startMs: number; endMs: number }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const seg = { startMs: bounds[i], endMs: bounds[i + 1] };
    if (out.length && seg.endMs - seg.startMs < minMs) out[out.length - 1].endMs = seg.endMs; else out.push(seg);
  }
  if (out.length > 1 && out[0].endMs - out[0].startMs < minMs) { out[1].startMs = 0; out.shift(); }
  return out;
}

export async function analyse(file: string, fallbackName: string): Promise<AlbumInfo> {
  const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], 60_000)).out);
  const audio = (probe.streams ?? []).find((s: any) => s.codec_type === 'audio');
  const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
  if (!audio || !durationMs) throw new Error('not_audio');
  if (durationMs > MAX_ALBUM_MS) throw new Error('too_long');
  const tags = Object.fromEntries(Object.entries(probe.format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const album = (tags.album || tags.title || fallbackName).slice(0, 100); const artist = (tags.artist || tags.album_artist || '').slice(0, 100);
  const base = { durationMs, codec: String(audio.codec_name), album, artist };
  const chapters: any[] = probe.chapters ?? [];
  if (chapters.length > 1) {
    return { ...base, source: 'chapters', segments: chapters.map((c, i) => ({ startMs: Math.round(Number(c.start_time) * 1000), endMs: Math.round(Number(c.end_time) * 1000), title: String(c.tags?.title || `Track ${i + 1}`).slice(0, 120) })) };
  }
  const { err } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'silencedetect=noise=-35dB:d=1.5', '-f', 'null', '-'], 30 * 60_000);
  const sil: Array<{ start: number; end: number }> = []; let cur: number | null = null;
  for (const line of err.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/); if (s) cur = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end: ([\d.]+)/); if (e && cur !== null) { sil.push({ start: cur, end: Number(e[1]) }); cur = null; }
  }
  const segs = segmentsFromSilence(durationMs, sil);
  return { ...base, source: segs.length > 1 ? 'silence' : 'single', segments: segs.map((s, i) => ({ ...s, title: `${album} ${i + 1}`.slice(0, 120) })) };
}

/** Cuts one track. Copies the audio as-is when the codec allows (fast, no quality loss); re-encodes to MP3 otherwise. */
export async function cutTrack(file: string, codec: string, seg: { startMs: number; endMs: number }, outDir: string, n: number): Promise<{ path: string; mime: string; ext: string }> {
  const copy = ({ mp3: ['mp3', 'audio/mpeg', 'mp3'], aac: ['m4a', 'audio/mp4', 'ipod'], vorbis: ['ogg', 'audio/ogg', 'ogg'], opus: ['ogg', 'audio/ogg', 'ogg'] } as Record<string, string[]>)[codec];
  const [ext, mime, fmt] = copy ?? ['mp3', 'audio/mpeg', 'mp3'];
  const path = join(outDir, `t${n}.${ext}`);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (seg.startMs / 1000).toFixed(3), '-to', (seg.endMs / 1000).toFixed(3), '-i', file, '-vn', '-map_metadata', '-1', ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'libmp3lame', '-b:a', '192k']), '-f', fmt, path], 10 * 60_000);
  return { path, mime, ext };
}
export const readTrack = (p: string) => readFile(p);
export const trackStream = (p: string) => createReadStream(p);
export const fileSize = async (p: string) => (await stat(p)).size;
export async function cleanupAlbum(id: string) { await rm(join(ALBUM_ROOT, id), { recursive: true, force: true }); }
/** Deletes leftovers older than an hour (abandoned uploads, crashes). */
export async function sweepAlbums() {
  try { for (const d of await readdir(ALBUM_ROOT)) { const s = await stat(join(ALBUM_ROOT, d)); if (Date.now() - s.mtimeMs > 3600_000) await rm(join(ALBUM_ROOT, d), { recursive: true, force: true }); } } catch { /* nothing to sweep */ }
}
