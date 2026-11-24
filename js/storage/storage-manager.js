/* HomeVault PWA – Storage Manager (File System Access API + OPFS Fallback) */
window.HVStorageManager = (() => {
  'use strict';

  const IDB_NAME = 'homevault-pwa-storage';
  const IDB_STORE = 'handles';
  const IDB_KEY_ROOT = 'rootDirHandle';
  const DB_FILENAME = 'homevault.db';
  const UPLOADS_DIR = 'uploads';
  const DEBOUNCE_MS = 1500;

  let mode = null; // 'fsa' | 'opfs'
  let rootHandle = null;
  let saveTimer = null;
  let isSaving = false;
  let pendingGetBytes = null;
  let statusCallback = null;

  function supportsFileSystemAccess() {
    return typeof window.showDirectoryPicker === 'function';
  }

  function supportsOPFS() {
    return !!(navigator.storage && typeof navigator.storage.getDirectory === 'function');
  }

  function onStatusChange(cb) {
    statusCallback = cb;
  }

  function emitStatus(state, message) {
    if (typeof statusCallback === 'function') {
      statusCallback({ state, message, mode, folderName: rootHandle ? rootHandle.name : null });
    }
  }

  /* --- IndexedDB persistence for FileSystemDirectoryHandle --- */
  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandleToIdb(handle) {
    const idb = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY_ROOT);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadHandleFromIdb() {
    try {
      const idb = await openIdb();
      return await new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY_ROOT);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async function clearHandleFromIdb() {
    try {
      const idb = await openIdb();
      return await new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(IDB_KEY_ROOT);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // ignore
    }
  }

  /* --- Initialization & Permissions --- */
  async function checkStoredState() {
    if (supportsFileSystemAccess()) {
      const stored = await loadHandleFromIdb();
      if (!stored) {
        return { mode: 'fsa', status: 'needs_setup', handle: null };
      }
      rootHandle = stored;
      mode = 'fsa';
      try {
        const perm = await stored.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          return { mode: 'fsa', status: 'ready', handle: stored, folderName: stored.name };
        }
        return { mode: 'fsa', status: 'needs_permission', handle: stored, folderName: stored.name };
      } catch {
        return { mode: 'fsa', status: 'needs_permission', handle: stored, folderName: stored.name };
      }
    }

    if (supportsOPFS()) {
      mode = 'opfs';
      const opfsRoot = await navigator.storage.getDirectory();
      rootHandle = await opfsRoot.getDirectoryHandle('homevault', { create: true });
      await rootHandle.getDirectoryHandle(UPLOADS_DIR, { create: true });
      const hasDb = await fileExists(rootHandle, DB_FILENAME);
      return { mode: 'opfs', status: 'ready', hasDb, folderName: 'Browser-Speicher (OPFS)' };
    }

    throw new Error('Dieser Browser unterstützt weder die File System Access API noch OPFS.');
  }

  async function pickDirectory() {
    if (!supportsFileSystemAccess()) {
      throw new Error('Ordnerauswahl wird in diesem Browser nicht unterstützt.');
    }
    const handle = await window.showDirectoryPicker({
      id: 'homevault-storage-dir',
      mode: 'readwrite'
    });
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      throw new Error('Schreibzugriff auf den gewählten Ordner wurde nicht erteilt.');
    }
    rootHandle = handle;
    mode = 'fsa';
    await saveHandleToIdb(handle);
    await ensureUploadsDir();
    emitStatus('saved', `Verbunden: ${handle.name}`);
    return handle;
  }

  async function reactivatePermission() {
    if (!rootHandle) {
      rootHandle = await loadHandleFromIdb();
    }
    if (!rootHandle) {
      throw new Error('Kein gespeicherter Ordner gefunden.');
    }
    const perm = await rootHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      throw new Error('Ordnerzugriff wurde abgelehnt.');
    }
    mode = 'fsa';
    await ensureUploadsDir();
    emitStatus('saved', `Verbunden: ${rootHandle.name}`);
    return rootHandle;
  }

  async function resetDirectory() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await clearHandleFromIdb();
    rootHandle = null;
  }

  /* --- Low-level Directory/File Helpers --- */
  function sanitizeRelPath(relPath) {
    const normalized = String(relPath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    const parts = normalized.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) {
      throw new Error('Ungültiger Dateipfad.');
    }
    for (const part of parts) {
      if (part === '.' || part === '..') {
        throw new Error(`Unsicherer Dateipfad erkannt: ${relPath}`);
      }
    }
    return parts;
  }

  async function ensureUploadsDir() {
    if (!rootHandle) throw new Error('Kein Speicherort initialisiert.');
    return rootHandle.getDirectoryHandle(UPLOADS_DIR, { create: true });
  }

  async function fileExists(dirHandle, filename) {
    try {
      await dirHandle.getFileHandle(filename, { create: false });
      return true;
    } catch {
      return false;
    }
  }

  async function hasDatabaseFile() {
    if (!rootHandle) return false;
    return fileExists(rootHandle, DB_FILENAME);
  }

  async function readDatabaseBytes() {
    if (!rootHandle) throw new Error('Kein Speicherort initialisiert.');
    try {
      const fh = await rootHandle.getFileHandle(DB_FILENAME, { create: false });
      const file = await fh.getFile();
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      if (err && err.name === 'NotFoundError') return null;
      throw err;
    }
  }

  async function writeDatabaseBytesAtomic(uint8Array) {
    if (!rootHandle) throw new Error('Kein Speicherort initialisiert.');
    isSaving = true;
    emitStatus('saving', 'Speichere homevault.db …');
    try {
      const fh = await rootHandle.getFileHandle(DB_FILENAME, { create: true });
      const writable = await fh.createWritable();
      await writable.write(uint8Array);
      await writable.close();
      emitStatus('saved', 'Gespeichert');
    } catch (err) {
      emitStatus('error', `Speicherfehler: ${err.message}`);
      throw err;
    } finally {
      isSaving = false;
    }
  }

  function scheduleSave(getBytesFn) {
    pendingGetBytes = getBytesFn;
    emitStatus('saving', 'Änderungen werden gleich gespeichert …');
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      await flushSave();
    }, DEBOUNCE_MS);
  }

  async function flushSave(overrideGetBytesFn) {
    if (overrideGetBytesFn) {
      pendingGetBytes = overrideGetBytesFn;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!pendingGetBytes || !rootHandle) return;
    if (isSaving) {
      // Retry shortly if a write is already in progress
      saveTimer = setTimeout(() => flushSave(), 400);
      return;
    }
    const fn = pendingGetBytes;
    pendingGetBytes = null;
    const bytes = fn();
    await writeDatabaseBytesAtomic(bytes);
  }

  /* --- Uploads / Documents Folder Operations --- */
  async function writeUploadFile(relPath, dataUint8) {
    const parts = sanitizeRelPath(relPath);
    let dir = await ensureUploadsDir();
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    const filename = parts[parts.length - 1];
    const fh = await dir.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(dataUint8);
    await writable.close();
    return parts.join('/');
  }

  async function readUploadFile(relPath) {
    const parts = sanitizeRelPath(relPath);
    let dir = await ensureUploadsDir();
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: false });
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: false });
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async function deleteUploadFile(relPath) {
    try {
      const parts = sanitizeRelPath(relPath);
      let dir = await ensureUploadsDir();
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create: false });
      }
      await dir.removeEntry(parts[parts.length - 1]);
    } catch {
      // ignore missing files
    }
  }

  async function clearUploadsDir() {
    if (!rootHandle) return;
    try {
      await rootHandle.removeEntry(UPLOADS_DIR, { recursive: true });
    } catch {
      // ignore if not present
    }
    await rootHandle.getDirectoryHandle(UPLOADS_DIR, { create: true });
  }

  async function listUploadFiles() {
    const results = [];
    let uploadsHandle;
    try {
      uploadsHandle = await ensureUploadsDir();
    } catch {
      return results;
    }

    async function walk(dirHandle, prefix) {
      for await (const [name, entry] of dirHandle.entries()) {
        if (name === '.DS_Store' || name === 'Thumbs.db') continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === 'directory') {
          await walk(entry, rel);
        } else if (entry.kind === 'file') {
          results.push({ relPath: rel, handle: entry });
        }
      }
    }

    await walk(uploadsHandle, '');
    return results;
  }

  function getInfo() {
    return {
      mode,
      folderName: rootHandle ? rootHandle.name : null,
      supportsFSA: supportsFileSystemAccess(),
      supportsOPFS: supportsOPFS()
    };
  }

  return {
    DB_FILENAME,
    UPLOADS_DIR,
    supportsFileSystemAccess,
    supportsOPFS,
    onStatusChange,
    checkStoredState,
    pickDirectory,
    reactivatePermission,
    resetDirectory,
    hasDatabaseFile,
    readDatabaseBytes,
    writeDatabaseBytesAtomic,
    scheduleSave,
    flushSave,
    writeUploadFile,
    readUploadFile,
    deleteUploadFile,
    clearUploadsDir,
    listUploadFiles,
    getInfo
  };
})();
