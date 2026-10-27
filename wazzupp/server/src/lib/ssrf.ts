import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** True for loopback, private, link-local, CGNAT, multicast, and unspecified addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' ) return true;
    if (l.startsWith('::ffff:')) return isPrivateAddress(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('64:ff9b') || l.startsWith('2001:db8');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported scheme');
  if (u.username || u.password) throw new Error('credentials in url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('private host');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('private address');
  return u;
}

export interface Preview { url: string; title: string | null; description: string | null; image: string | null; siteName: string | null; }
const cache = new Map<string, { at: number; v: Preview | null }>();

export async function fetchPreview(raw: string): Promise<Preview | null> {
  const hit = cache.get(raw);
  if (hit && Date.now() - hit.at < 3600_000) return hit.v;
  let url = await assertPublicUrl(raw);
  let res: Response | null = null;
  for (let i = 0; i < 4; i++) {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'WazzuppLinkPreview/1.0', accept: 'text/html' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString()); continue; }
    break;
  }
  let out: Preview | null = null;
  if (res && res.ok && (res.headers.get('content-type') ?? '').includes('text/html') && res.body) {
    const reader = res.body.getReader(); let html = ''; let n = 0;
    while (n < 300_000) { const { done, value } = await reader.read(); if (done) break; n += value.length; html += new TextDecoder().decode(value); if (/<\/head>/i.test(html)) break; }
    reader.cancel().catch(() => {});
    const meta = (prop: string) => {
      const m = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html) ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i').exec(html);
      return m ? decode(m[1]).slice(0, 300) : null;
    };
    const title = meta('og:title') ?? (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)![1]).trim().slice(0, 200) : null);
    let image = meta('og:image');
    try { image = image ? new URL(image, url).toString() : null; if (image && !image.startsWith('https://')) image = null; } catch { image = null; }
    out = { url: url.toString(), title, description: meta('og:description') ?? meta('description'), image, siteName: meta('og:site_name') };
    if (!out.title && !out.description) out = null;
  }
  cache.set(raw, { at: Date.now(), v: out });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return out;
}
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
