/* HomeVault PWA – Local PDF Preview & Offline Text/Metadata Extraction (pdf.js) */
window.HVPdfService = (() => {
  'use strict';

  let currentPdfDoc = null;
  let currentPage = 1;
  let currentScale = 1.25;

  function ensureWorker() {
    if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.js';
    }
  }

  async function extractTextAndSuggestions(uint8Array) {
    ensureWorker();
    if (typeof pdfjsLib === 'undefined') {
      return { text: '', suggestions: { providers: [], ibans: [], amounts: [], dates: [], contractNumbers: [] } };
    }

    const loadingTask = pdfjsLib.getDocument({ data: uint8Array.slice() });
    const pdf = await loadingTask.promise;
    const maxPages = Math.min(pdf.numPages, 15);
    const pageTexts = [];

    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const str = content.items.map((item) => item.str || '').join(' ');
      pageTexts.push(str);
    }

    const fullText = pageTexts.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
    const suggestions = await extractPatterns(fullText);
    return { text: fullText, suggestions, pageCount: pdf.numPages };
  }

  async function extractPatterns(text) {
    const providers = [];
    const ibans = [];
    const amounts = [];
    const dates = [];
    const contractNumbers = [];

    if (!text) return { providers, ibans, amounts, dates, contractNumbers };

    // 0. Known providers from offline catalog (providers_contacts.json)
    try {
      if (window.HVEmergencyContacts && typeof window.HVEmergencyContacts.loadCatalog === 'function') {
        const catalog = await window.HVEmergencyContacts.loadCatalog();
        const lower = text.toLowerCase();
        if (Array.isArray(catalog)) {
          for (const entry of catalog) {
            const name = entry.provider || entry.name || '';
            const kws = Array.isArray(entry.keywords) ? entry.keywords : [name];
            if (name && kws.some((kw) => {
              const k = String(kw || '').trim().toLowerCase();
              if (!k) return false;
              if (k.length <= 4) {
                return new RegExp(`(^|[^a-z0-9äöüß])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9äöüß])`, 'i').test(lower);
              }
              return lower.includes(k);
            })) {
              if (!providers.includes(name)) providers.push(name);
              if (providers.length >= 3) break;
            }
          }
        }
      }
    } catch {
      // ignore catalog lookup errors
    }

    // Fallback: company names with GmbH / AG / eG / SE / KG in first 600 chars
    if (providers.length === 0) {
      const head = text.slice(0, 600);
      const compRe = /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9&\-\.\s]{2,40}\s(?:GmbH|AG|eG|SE|OHG|KG|mbH|e\.V\.))/g;
      let cm;
      while ((cm = compRe.exec(head)) !== null) {
        const name = cm[1].replace(/\s{2,}/g, ' ').trim();
        if (name.length >= 4 && !providers.includes(name)) providers.push(name);
        if (providers.length >= 2) break;
      }
    }

    // 1. IBANs (DE + European)
    const ibanRe = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?)\b/g;
    let m;
    while ((m = ibanRe.exec(text)) !== null) {
      const clean = m[1].replace(/\s+/g, '');
      if (clean.length >= 15 && clean.length <= 34 && !ibans.includes(clean)) {
        ibans.push(clean);
      }
      if (ibans.length >= 4) break;
    }

    // 2. Euro Amounts (e.g. 49,99 € or EUR 129,00)
    const amountRe = /(?:(?:EUR|€)\s*(\d{1,5}(?:\.\d{3})*,\d{2})|(\d{1,5}(?:\.\d{3})*,\d{2})\s*(?:EUR|€))/gi;
    while ((m = amountRe.exec(text)) !== null) {
      const raw = (m[1] || m[2] || '').trim();
      if (raw && !amounts.includes(raw)) {
        amounts.push(raw);
      }
      if (amounts.length >= 6) break;
    }

    // 3. German Dates (DD.MM.YYYY) -> convert to ISO YYYY-MM-DD
    const dateRe = /\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.((?:19|20)\d{2})\b/g;
    while ((m = dateRe.exec(text)) !== null) {
      const dd = m[1].padStart(2, '0');
      const mm = m[2].padStart(2, '0');
      const yyyy = m[3];
      const iso = `${yyyy}-${mm}-${dd}`;
      if (!dates.some((d) => d.iso === iso)) {
        dates.push({ iso, display: `${dd}.${mm}.${yyyy}` });
      }
      if (dates.length >= 6) break;
    }

    // 4. Contract / Policy / Customer numbers
    const numRe = /(?:Vertragsnummer|Vertrags-?Nr\.?|Versicherungsschein-?Nr\.?|Policen-?Nr\.?|Kundennummer|Kunden-?Nr\.?|Mitgliedsnummer|Beitragsnummer)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/\.]{3,28})/gi;
    while ((m = numRe.exec(text)) !== null) {
      const val = m[1].replace(/[.,;:]$/, '').trim();
      if (val.length >= 4 && !contractNumbers.includes(val)) {
        contractNumbers.push(val);
      }
      if (contractNumbers.length >= 5) break;
    }

    return { providers, ibans, amounts, dates, contractNumbers };
  }

  /* --- Modal Canvas Renderer --- */
  async function loadPdfForPreview(uint8Array) {
    ensureWorker();
    if (currentPdfDoc) {
      try { await currentPdfDoc.destroy(); } catch { /* ignore */ }
      currentPdfDoc = null;
    }
    const loadingTask = pdfjsLib.getDocument({ data: uint8Array.slice() });
    currentPdfDoc = await loadingTask.promise;
    currentPage = 1;
    currentScale = 1.25;
    return { numPages: currentPdfDoc.numPages, currentPage };
  }

  async function renderPage(canvas, pageNum = currentPage, scale = currentScale) {
    if (!currentPdfDoc || !canvas) return null;
    currentPage = Math.max(1, Math.min(pageNum, currentPdfDoc.numPages));
    currentScale = Math.max(0.6, Math.min(scale, 2.5));

    const page = await currentPdfDoc.getPage(currentPage);
    const viewport = page.getViewport({ scale: currentScale });
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport }).promise;
    return {
      currentPage,
      numPages: currentPdfDoc.numPages,
      scale: currentScale
    };
  }

  function getPreviewState() {
    return {
      currentPage,
      numPages: currentPdfDoc ? currentPdfDoc.numPages : 0,
      scale: currentScale
    };
  }

  return {
    extractTextAndSuggestions,
    loadPdfForPreview,
    renderPage,
    getPreviewState
  };
})();
