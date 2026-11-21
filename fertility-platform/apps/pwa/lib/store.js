// Encrypted on-device storage. Everything the user logs lives in IndexedDB, encrypted with AES-256-GCM under
// a key derived from their password (PBKDF2-SHA256). The key exists only in memory while the app is unlocked,
// so data at rest on the phone is unreadable without the password. (The production app uses SQLCipher.)

const ITERATIONS = 250_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function dbNameFor(email) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(`cycle-demo:${email.trim().toLowerCase()}`));
  return `cycle-${[...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function openDb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { for (const s of ['meta', 'events', 'kv']) r.result.createObjectStore(s); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export class WrongPasswordError extends Error {}

export class Vault {
  constructor(db, key, name) { this.db = db; this.key = key; this.name = name; }

  /** True if this device already holds an encrypted store for this e-mail. */
  static async exists(email) {
    const name = await dbNameFor(email);
    const db = await openDb(name);
    try { return (await wrap(db.transaction('meta').objectStore('meta').get('salt'))) !== undefined; } finally { db.close(); }
  }

  static async create(email, password) {
    const name = await dbNameFor(email);
    const db = await openDb(name);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt, ITERATIONS);
    const v = new Vault(db, key, name);
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(toB64(salt), 'salt');
    tx.objectStore('meta').put(ITERATIONS, 'iterations');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    await v.put('meta-enc', 'canary', 'ok'); // proves a password is right without any server
    return v;
  }

  static async unlock(email, password) {
    const name = await dbNameFor(email);
    const db = await openDb(name);
    const salt = await wrap(db.transaction('meta').objectStore('meta').get('salt'));
    const iterations = await wrap(db.transaction('meta').objectStore('meta').get('iterations'));
    if (salt === undefined) { db.close(); throw new Error('no local data for this account'); }
    const v = new Vault(db, await deriveKey(password, fromB64(salt), iterations), name);
    try {
      if ((await v.get('meta-enc', 'canary')) !== 'ok') throw new WrongPasswordError();
    } catch { db.close(); throw new WrongPasswordError('wrong password'); }
    return v;
  }

  static async destroy(email) {
    const name = await dbNameFor(email);
    await new Promise((res) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  }

  // Values are JSON, encrypted with a random 96-bit IV; the store+key name is authenticated as AAD so a
  // ciphertext cannot be moved to another record. 'meta-enc' lives in the kv store under a prefixed key.
  #loc(store, key) { return store === 'meta-enc' ? ['kv', `meta-enc:${key}`] : [store, key]; }

  async put(store, key, value) {
    const [s, k] = this.#loc(store, key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${s}:${k}`) }, this.key, enc.encode(JSON.stringify(value)));
    const tx = this.db.transaction(s, 'readwrite');
    tx.objectStore(s).put({ iv: toB64(iv), ct: toB64(ct) }, k);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }

  async #decrypt(s, k, rec) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(rec.iv), additionalData: enc.encode(`${s}:${k}`) }, this.key, fromB64(rec.ct));
    return JSON.parse(dec.decode(pt));
  }

  async get(store, key) {
    const [s, k] = this.#loc(store, key);
    const rec = await wrap(this.db.transaction(s).objectStore(s).get(k));
    return rec === undefined ? undefined : this.#decrypt(s, k, rec);
  }

  async all(store) {
    const os = this.db.transaction(store).objectStore(store);
    const keys = await wrap(os.getAllKeys());
    const recs = await wrap(this.db.transaction(store).objectStore(store).getAll());
    return Promise.all(recs.map((r, i) => this.#decrypt(store, keys[i], r)));
  }

  close() { this.db.close(); }
}
