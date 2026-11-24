/* HomeVault PWA – 100% QNAP-Compatible ZIP Backup & Restore Service */
window.HVBackupService = (() => {
  'use strict';

  const BACKUP_APP_ID = 'homevault'; // Exact lowercase ID required by QNAP /api/backup/restore
  const BACKUP_SCHEMA_VERSION = 1;
  const REQUIRED_TABLES = ['users', 'contracts', 'documents'];

  function validateZipPath(rawPath) {
    const p = String(rawPath || '').replace(/\\/g, '/');
    if (!p || p.startsWith('/') || p.includes('\0')) {
      throw new Error(`Unsicherer ZIP-Pfad abgelehnt: ${rawPath}`);
    }
    const parts = p.split('/').filter((seg) => seg.length > 0);
    for (const seg of parts) {
      if (seg === '.' || seg === '..') {
        throw new Error(`Zip-Slip-Pfad erkannt und abgelehnt: ${rawPath}`);
      }
    }
    return parts.join('/');
  }

  function validateDatabase(SQL, dbBytes) {
    let testDb;
    try {
      testDb = new SQL.Database(dbBytes);
    } catch (err) {
      throw new Error(`Datenbankdatei ist keine gültige SQLite-Datenbank: ${err.message}`);
    }

    // 1. PRAGMA integrity_check
    const integrityRes = testDb.exec('PRAGMA integrity_check;');
    const integrityVal =
      integrityRes.length && integrityRes[0].values.length
        ? String(integrityRes[0].values[0][0]).toLowerCase()
        : '';
    if (integrityVal !== 'ok') {
      testDb.close();
      throw new Error(`SQLite-Integritätsprüfung fehlgeschlagen: ${integrityVal || 'unbekannt'}`);
    }

    // 2. Check required QNAP tables
    const tablesRes = testDb.exec("SELECT name FROM sqlite_master WHERE type='table';");
    const existingTables = new Set(
      tablesRes.length ? tablesRes[0].values.map((r) => String(r[0])) : []
    );
    const missing = REQUIRED_TABLES.filter((t) => !existingTables.has(t));
    if (missing.length > 0) {
      testDb.close();
      throw new Error(`Erforderliche HomeVault-Tabellen fehlen: ${missing.join(', ')}`);
    }

    return testDb;
  }

  async function importBackupZip(fileOrBuffer, SQL, storageManager, onProgress) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip ist nicht geladen.');
    }

    if (onProgress) onProgress('Öffne ZIP-Archiv …');
    const zip = await JSZip.loadAsync(fileOrBuffer);

    // Validate all paths for Zip-Slip
    const allEntryNames = Object.keys(zip.files);
    for (const name of allEntryNames) {
      if (name === '' || name === '/') continue;
      validateZipPath(name);
    }

    // 1. Validate manifest.json
    const manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) {
      throw new Error('manifest.json fehlt im Backup-Archiv.');
    }
    let manifest;
    try {
      manifest = JSON.parse(await manifestEntry.async('string'));
    } catch {
      throw new Error('manifest.json ist kein gültiges JSON.');
    }

    const appId = String(manifest.app || '').trim().toLowerCase();
    if (appId !== BACKUP_APP_ID) {
      throw new Error(`Ungültige Backup-Kennung in manifest.json: "${manifest.app || ''}" (erwartet: HomeVault).`);
    }

    // 2. Load and validate SQLite database
    const dbFilename = validateZipPath(manifest.db_filename || 'homevault.db');
    const dbEntry = zip.file(dbFilename);
    if (!dbEntry) {
      throw new Error(`Datenbankdatei "${dbFilename}" fehlt im Backup-Archiv.`);
    }

    if (onProgress) onProgress('Prüfe SQLite-Datenbank (PRAGMA integrity_check) …');
    const dbBytes = await dbEntry.async('uint8array');
    const validatedDb = validateDatabase(SQL, dbBytes);

    // Non-destructive compatibility check (never drops QNAP tables like mail_logs/statement_logs/users)
    window.HVSchema.ensureSchema(validatedDb);

    // 3. Extract documents/ and/or uploads/ into local uploads/
    if (onProgress) onProgress('Entpacke Dokumente in den lokalen Speicher …');
    await storageManager.clearUploadsDir();

    const docEntries = [];
    zip.forEach((relPath, zipObj) => {
      if (zipObj.dir) return;
      const clean = validateZipPath(relPath);
      if (clean.startsWith('documents/') && clean.length > 'documents/'.length) {
        docEntries.push({ targetRel: clean.slice('documents/'.length), zipObj });
      } else if (clean.startsWith('uploads/') && clean.length > 'uploads/'.length) {
        docEntries.push({ targetRel: clean.slice('uploads/'.length), zipObj });
      }
    });

    let importedDocsCount = 0;
    for (const item of docEntries) {
      const bytes = await item.zipObj.async('uint8array');
      await storageManager.writeUploadFile(item.targetRel, bytes);
      importedDocsCount += 1;
    }

    // 4. Write homevault.db atomically to local storage
    if (onProgress) onProgress('Schreibe homevault.db …');
    const finalDbBytes = validatedDb.export();
    await storageManager.writeDatabaseBytesAtomic(finalDbBytes);

    return {
      db: validatedDb,
      manifest,
      importedDocsCount
    };
  }

  async function exportBackupZip(db, storageManager, onProgress) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip ist nicht geladen.');
    }

    // Ensure pending debounced writes are flushed first
    await storageManager.flushSave(() => db.export());

    if (onProgress) onProgress('Erstelle SQLite-Snapshot …');
    const dbBytes = db.export();

    const contractsCountRes = db.exec('SELECT COUNT(*) FROM contracts;');
    const usersCountRes = db.exec('SELECT COUNT(*) FROM users;');
    const contractsCount = contractsCountRes.length ? Number(contractsCountRes[0].values[0][0]) : 0;
    const usersCount = usersCountRes.length ? Number(usersCountRes[0].values[0][0]) : 0;

    if (onProgress) onProgress('Sammle hochgeladene Dokumente …');
    const uploadFiles = await storageManager.listUploadFiles();

    const nowUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const manifest = {
      app: BACKUP_APP_ID,
      schema_version: BACKUP_SCHEMA_VERSION,
      created_at_utc: nowUtc,
      db_filename: 'homevault.db',
      documents_count: uploadFiles.length,
      contracts_count: contractsCount,
      users_count: usersCount
    };

    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('homevault.db', dbBytes);

    for (const entry of uploadFiles) {
      const file = await entry.handle.getFile();
      const buf = await file.arrayBuffer();
      // Store under documents/ for 100% direct compatibility with QNAP /api/backup/restore
      zip.file(`documents/${entry.relPath}`, new Uint8Array(buf));
    }

    if (onProgress) onProgress('Komprimiere ZIP-Archiv …');
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    const stamp = nowUtc.replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    const filename = `homevault_backup_${stamp}.zip`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    return { filename, manifest };
  }

  return {
    importBackupZip,
    exportBackupZip
  };
})();
