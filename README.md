# HomeVault

**HomeVault** ist eine schlanke, 100 % offline-fähige Progressive Web App (PWA) zur übersichtlichen Verwaltung von Verträgen, monatlichen Fixkosten, PDF-Dokumenten und wichtigen Kontakten für den Ernstfall.

## Funktionen

- **Vertrags- & Fixkostenübersicht:** Alle laufenden Verträge nach Kategorien geordnet inklusive monatlicher und jährlicher Fixkosten- und Investment-Berechnung sowie Fristenwarnung.
- **PDF-Verwaltung:** Vertragsdokumente direkt lokal speichern, im integrierten Viewer ansehen und im Volltext durchsuchen (inkl. lokaler Erkennung von IBAN, Beträgen, Daten und Vertragsnummern).
- **Notfall-Ansicht:** Kompakte, druckbare Übersicht aller aktiven Verträge mit Vertrags- und Kundennummern (1-Klick-Kopieren) sowie Notfallkontakten.
- **Kontoauszug-Analyse:** Lokale Auswertung von CSV- und PDF-Kontoauszügen zur schnellen Erfassung wiederkehrender Ausgaben.
- **Datensicherung:** Vollständiger Export und Import der Datenbank inklusive aller angehängten PDFs als `.zip`-Archiv.

## Datenschutz

HomeVault arbeitet **100 % lokal** auf deinem Gerät:
- Es gibt keinen Backend-Server, keine Benutzerkonten und keine Datenübertragung ins Internet.
- Alle Daten (`homevault.db` und `uploads/`) bleiben ausschließlich in deinem gewählten lokalen Ordner (z. B. lokal, OneDrive, Google Drive, Dropbox) bzw. im lokalen Browser-Speicher (OPFS).
- Alle benötigten Bibliotheken sind lokal gebündelt und funktionieren nach dem ersten Aufruf vollständig offline.

## Nutzung & Installation in 3 Schritten

1. **Öffnen:** Rufe **https://gizmina.github.io/homevault-pwa/** in einem modernen Browser (Chrome, Edge, Brave, Safari oder Firefox) auf.
2. **Als App installieren:** Klicke oben auf **„App installieren“** (Chrome/Edge/Brave) bzw. in Safari auf **Ablage / Teilen → Zum Dock hinzufügen** (macOS) oder **Zum Home-Bildschirm** (iOS/iPadOS).
3. **Speicherort wählen:** Wähle beim ersten Start deinen gewünschten Speicherordner (oder lade ein vorhandenes `.zip`-Backup) – danach kannst du HomeVault jederzeit und komplett offline nutzen.
