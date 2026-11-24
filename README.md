# HomeVault PWA (100 % Offline-Version für Windows & macOS)

**HomeVault PWA** ist die vollständig statische, 100 % offline-fähige Browser-Version von HomeVault – ohne Backend-Server, ohne Cloud-API-Tokens und ohne externe CDNs zur Laufzeit.

Sie liest und schreibt exakt dasselbe SQLite-Datenbankschema (`homevault.db`) und dasselbe `.zip`-Backup-Format (`manifest.json`, `homevault.db`, `documents/...`) wie die QNAP-NAS-Version von HomeVault.

---

## Funktionsumfang

- **100 % Offline & Zero-CDN:** Identisches QNAP-Design (lokales Tailwind CSS + Heroicons SVGs) sowie alle Bibliotheken (`sql.js` + WASM, `JSZip`, `pdf.js` + Worker, `PapaParse`) liegen lokal im Ordner `vendor/` und werden per Service Worker (`sw.js`) gecacht.
- **Direkte Ordner- & Cloud-Sync-Integration (Chrome, Edge, Brave):**
  - Wähle beim ersten Start einen lokalen Ordner oder einen Cloud-Ordner (OneDrive, Google Drive, Dropbox).
  - Änderungen werden mit 1,5 s Debounce atomar als geschlossene `homevault.db` geschrieben (keine `-wal`/`-journal`-Dateien, keine Cloud-Konfliktkopien).
  - Nach einem Browser-Neustart genügt ein Klick auf **„Ordnerzugriff wieder aktivieren“**.
- **Automatischer OPFS-Fallback (Safari & Firefox):**
  - Speichert Daten lokal im Origin Private File System (OPFS) des Browsers und blendet oben eine Statusleiste mit **„Backup als ZIP sichern“** und **„ZIP laden“** ein.
- **100 % QNAP-kompatibles Backup & Restore (`.zip`):**
  - Importiert QNAP- und PWA-Backups inkl. `manifest.json`-Prüfung, Zip-Slip-Schutz und SQLite `PRAGMA integrity_check`.
  - Bewahrt alle QNAP-Tabellen (`users`, `mail_logs`, `statement_logs`, `contracts`, `documents`) verlustfrei für den späteren Re-Import aufs NAS.
- **Lokale Intelligenz ohne KI-API:**
  - **PDF-Upload & Vorschau:** Lokale Vorschau via `pdf.js` sowie automatische Erkennung von IBANs, Euro-Beträgen, Daten und Vertragsnummern als anklickbare Vorschläge.
  - **CSV-Import:** Lokale Analyse von Bank- (ING, Sparkasse, DKB), Amex- und PayPal-CSVs (inkl. 14-Tage-/Monats-/Jahres-Erkennung & PayPal-Durchlauf-Filter).
  - **Notfall-Ansicht & Offline-Anbieterverzeichnis:** Druckbare Notfall-Übersicht mit anklickbaren Telefon-, E-Mail- und Portal-Links.

---

## Nutzungsmöglichkeiten

> **Wichtig:** Service Worker, WebAssembly (`sql.js`) und die File System Access API benötigen entweder `https://` oder `http://127.0.0.1` / `http://localhost` (nicht `file://`).

### Option 1: Ein-Klick-Start ohne offenes Konsolenfenster (Windows & macOS)
Entpacke `homevault-pwa.zip` und starte die App direkt per Doppelklick – es bleibt kein schwarzes Konsolen-/Terminalfenster offen:

- **Windows:** Doppelklick auf **`Start-HomeVault.vbs`** (alternativ `Start-HomeVault.bat`, das automatisch an `Start-HomeVault.vbs` übergibt und sich sofort schließt)
  - Prüft zuerst, ob HomeVault bereits auf `127.0.0.1:8742` läuft (verhindert doppelte Instanzen), startet den lokalen HTTP-Server komplett unsichtbar im Hintergrund (Python 3 oder automatisch den integrierten Windows-PowerShell-Server als Fallback) und öffnet `http://127.0.0.1:8742` im Standardbrowser.
- **macOS:** Doppelklick auf **`Start-HomeVault.command`**
  - Prüft zuerst, ob HomeVault bereits läuft (öffnet dann nur den Browser), startet den lokalen Python-3-HTTP-Server entkoppelt im Hintergrund (`nohup ... &`), öffnet `http://127.0.0.1:<PORT>` im Standardbrowser und schließt das Terminalfenster direkt wieder.
  - *Hinweis bei erstem Start auf macOS:* Falls Gatekeeper fragt, Rechtsklick → **Öffnen** wählen.

### Option 2: GitHub Pages (inkl. Unterpfad wie `/homevault-pwa/`) & PWA-Installation
Der gesamte Ordner `homevault-pwa/` ist vollständig für **GitHub Pages** vorbereitet:
- **100 % relative Pfade (`./...`):** Alle Assets, Skripte, `sql-wasm.wasm`, `pdf.worker.min.js`, `manifest.webmanifest` (`"start_url": "./"`, `"scope": "./"`) und `sw.js` funktionieren sowohl auf einer Root-Domain als auch in einem Repository-Unterpfad (z. B. `https://<benutzer>.github.io/homevault-pwa/`).
- **`.nojekyll`:** Verhindert, dass GitHub Pages Dateien oder Unterordner über Jekyll filtert.
- **`.gitignore` (Datenschutz):** Schließt `*.db`, `*.sqlite*`, `uploads/`, `safety_backups/` und `*.zip` automatisch aus, damit niemals versehentlich persönliche Vertragsdaten auf GitHub hochgeladen werden.

**Deployment in 3 Schritten:**
1. Erstelle ein GitHub-Repository (z. B. `homevault-pwa`) und lade den gesamten Inhalt von `homevault-pwa/` (inkl. `.nojekyll` und `.gitignore`) in den Branch `main` hoch.
2. Aktiviere unter **Settings → Pages** als Quelle *Deploy from a branch* (`main` / `/ (root)`).
3. Öffne die HTTPS-URL im Browser und klicke oben rechts auf **„App installieren“** (Chrome, Edge, Brave) bzw. in Safari auf **Ablage / Teilen → Zum Dock hinzufügen** – anschließend läuft HomeVault komplett offline aus dem Cache.

### Option 3: Portabler USB-Stick (Windows & macOS)
1. Kopiere den entpackten Ordner `homevault-pwa/` sowie deinen Datenordner (z. B. `HomeVault-Daten/` mit `homevault.db` und `uploads/` oder ein aktuelles `homevault_backup_*.zip`) auf einen USB-Stick (exFAT).
2. Starte auf Windows `Start-HomeVault.bat` bzw. auf macOS `Start-HomeVault.command` per Doppelklick.
3. Wähle im Einrichtungsbildschirm den Datenordner auf dem USB-Stick – alle Verträge und PDFs sind sofort offline verfügbar und Änderungen werden direkt zurückgeschrieben.

---

## Wechsel zwischen QNAP NAS und HomeVault PWA

- **QNAP → PWA:** Im QNAP-HomeVault unter *Einstellungen → Datensicherung* das Komplett-Backup (`.zip`) herunterladen und in der PWA beim Start oder unter *Einstellungen* wiederherstellen.
- **PWA → QNAP:** In der PWA unter *Einstellungen → Komplett-Backup (.zip) herunterladen* exportieren und im QNAP-HomeVault unter *Einstellungen → Datensicherung* wiederherstellen.
