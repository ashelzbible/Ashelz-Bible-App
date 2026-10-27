import { api, uploadWithProgress } from './api.ts';

export const MUSIC_CHANGED = 'wz-music-changed';
/** Fired when the server says this account's library changed (from any device), so open screens refetch. */
export const announceMusicChanged = () => window.dispatchEvent(new CustomEvent(MUSIC_CHANGED));

/** "Artist - Title.mp3" → { artist, title }; anything else becomes just a tidy title. */
export function parseSongName(file: string): { title: string; artist: string } {
  const base = file.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = base.match(/^(.{2,60}?)\s+-\s+(.{1,100})$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base || 'Untitled' };
}

export interface UploadItem { id: string; name: string; state: 'waiting' | 'uploading' | 'done' | 'failed'; progress: number; error?: string; file: File }

/** Uploads songs three at a time and adds each to the library. Reports every change so the UI can show per-file progress. */
export async function addSongs(files: File[], onChange: (items: UploadItem[]) => void, opts: { mood?: string; genre?: string } = {}): Promise<number> {
  const items: UploadItem[] = files.map((file) => ({ id: crypto.randomUUID(), name: file.name, state: 'waiting', progress: 0, file }));
  const push = () => onChange(items.map((i) => ({ ...i })));
  push();
  let next = 0; let ok = 0;
  const one = async (it: UploadItem) => {
    it.state = 'uploading'; push();
    try {
      const up = await uploadWithProgress(it.file, it.file.name, 'audio', {}, (p) => { it.progress = p; push(); }).promise;
      const { title, artist } = parseSongName(it.file.name);
      await api.post('/api/music', { mediaId: up.media.id, title: title.slice(0, 120), artist: artist.slice(0, 120), mood: opts.mood ?? '', genre: opts.genre ?? '' });
      it.state = 'done'; it.progress = 1; ok++;
    } catch (e: any) { it.state = 'failed'; it.error = e?.message || 'Upload failed'; }
    push();
  };
  const worker = async () => { while (next < items.length) await one(items[next++]); };
  await Promise.all([worker(), worker(), worker()]);
  return ok;
}
