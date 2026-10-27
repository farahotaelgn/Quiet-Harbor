import { BRAND } from './Brand.js';
import { createVault, openVault, seal, unseal } from './Core/Vault.js';

const DB_NAME = BRAND.storageName;
const SESSIONS = 'sessions';
const META = 'meta';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(db, store, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export class SessionStore extends EventTarget {
  constructor() {
    super();
    this.db = null;
    this.key = null;
    this.vault = null;
    this.sessions = [];
    this.readFiles = new Set(); // ring files already downloaded, kept even if their session is deleted
  }

  get isLocked() { return this.key === null; }
  get hasPassword() { return this.vault !== null; }
  async open() {
    try {
      this.db = await openDatabase();
      this.vault = (await run(this.db, META, 'readonly', (s) => s.get('vault'))) ?? null;
      await navigator.storage?.persist?.();
    } catch {
      this.db = null; // blocked storage: sessions live in memory only
    }
  }

  async createPassword(password) {
    const { vault, key } = await createVault(password);
    this.vault = vault;
    this.key = key;
    if (this.db) await run(this.db, META, 'readwrite', (s) => s.put(vault, 'vault'));
    await this.#load();
    for (const session of this.sessions) await this.#save(session);
    await this.#saveReadFiles();
    this.#changed();
  }

  async unlock(password) {
    const key = await openVault(this.vault, password);
    if (!key) return false;
    this.key = key;
    await this.#load();
    this.#changed();
    return true;
  }

  lock() {
    this.key = null;
    this.sessions = [];
    this.readFiles = new Set();
    this.#changed();
  }
  async eraseEverything() {
    if (this.db) {
      await run(this.db, SESSIONS, 'readwrite', (s) => s.clear());
      await run(this.db, META, 'readwrite', (s) => s.clear());
    }
    this.vault = null;
    this.lock();
  }

  async add(session) {
    if (this.sessions.some((s) => s.id === session.id)) return false;
    this.sessions.push(session);
    this.#sort();
    await this.#save(session);
    this.#changed();
    return true;
  }

  async remove(id) {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.db) await run(this.db, SESSIONS, 'readwrite', (s) => s.delete(id));
    this.#changed();
  }

  find(id) { return this.sessions.find((s) => s.id === id); }
  hasRingFile(name) {
    return this.readFiles.has(name) || this.sessions.some((s) => s.sourceFileName === `${name}.dat`);
  }

  async markRead(name) {
    this.readFiles.add(name);
    await this.#saveReadFiles();
  }

  async forgetReadFiles() {
    this.readFiles = new Set();
    await this.#saveReadFiles();
    this.#changed();
  }

  async #load() {
    if (!this.db) return;
    const records = (await run(this.db, SESSIONS, 'readonly', (s) => s.getAll())) ?? [];
    this.sessions = [];
    for (const record of records) {
      try {
        this.sessions.push(record.sealed ? await unseal(this.key, record.sealed) : record);
      } catch {
      }
    }
    const read = await run(this.db, META, 'readonly', (s) => s.get('readFiles'));
    this.readFiles = new Set(read ? await unseal(this.key, read).catch(() => []) : []);
    this.#sort();
  }

  async #save(session) {
    if (!this.db || !this.key) return;
    const sealed = await seal(this.key, session);
    await run(this.db, SESSIONS, 'readwrite', (s) => s.put({ id: session.id, sealed }));
  }

  async #saveReadFiles() {
    if (!this.db || !this.key) return;
    const sealed = await seal(this.key, [...this.readFiles]);
    await run(this.db, META, 'readwrite', (s) => s.put(sealed, 'readFiles'));
  }

  #sort() { this.sessions.sort((a, b) => b.startDate - a.startDate); }
  #changed() { this.dispatchEvent(new Event('change')); }
}
