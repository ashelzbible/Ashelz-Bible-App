export class ApiError extends Error {
  status: number; code: string; details?: any;
  constructor(status: number, code: string, message: string, details?: any) { super(message); this.status = status; this.code = code; this.details = details; }
}

let token: string | null = null;
let onUnauthorized: () => void = () => {};
export const setToken = (t: string | null) => { token = t; };
export const getToken = () => token;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function request<T>(method: string, url: string, body?: unknown, opts: { form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (opts.form) payload = opts.form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res: Response;
  try { res = await fetch(url, { method, headers, body: payload, signal: opts.signal }); }
  catch (e) { throw new ApiError(0, 'network', 'You appear to be offline'); }
  if (res.status === 204) return undefined as T;
  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && token && err.code !== 'invalid_credentials' && err.code !== 'mfa_required' && err.code !== 'invalid_mfa') onUnauthorized();
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? res.statusText, err.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, { signal }),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T = any>(url: string, body: unknown = {}) => request<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown = {}) => request<T>('PATCH', url, body),
  del: <T = any>(url: string, body?: unknown) => request<T>('DELETE', url, body),
  upload: <T = any>(file: Blob, filename: string, kind: string, extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.append('kind', kind);
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    f.append('file', file, filename);
    return request<T>('POST', '/api/media', undefined, { form: f });
  },
};

/** Upload with progress (fetch has no upload progress events). */
export function uploadWithProgress(file: Blob, filename: string, kind: string, extra: Record<string, string>, onProgress: (p: number) => void): { promise: Promise<any>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<any>((resolve, reject) => {
    xhr.open('POST', '/api/media');
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data: any = null; try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Upload failed'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Upload failed: offline'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    const f = new FormData(); f.append('kind', kind); for (const [k, v] of Object.entries(extra)) f.append(k, v); f.append('file', file, filename);
    xhr.send(f);
  });
  return { promise, abort: () => xhr.abort() };
}
