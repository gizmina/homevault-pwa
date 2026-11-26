/* HomeVault PWA – Local PDF Multi-Page Retina Viewer & Offline Text/Metadata Extraction (pdf.js) */
window.HVPdfService = (() => {
  'use strict';

  let currentPdfDoc = null;
  let activeRenderToken = 0;

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

    // 1. IBANs
    const ibanRe = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?)\b/g;
    let m;
    while ((m = ibanRe.exec(text)) !== null) {
      const clean = m[1].replace(/\s+/g, '');
      if (clean.length >= 15 && clean.length <= 34 && !ibans.includes(clean)) {
        ibans.push(clean);
      }
      if (ibans.length >= 4) break;
    }

    // 2. Euro Amounts
    const amountRe = /(?:(?:EUR|€)\s*(\d{1,5}(?:\.\d{3})*,\d{2})|(\d{1,5}(?:\.\d{3})*,\d{2})\s*(?:EUR|€))/gi;
    while ((m = amountRe.exec(text)) !== null) {
      const raw = (m[1] || m[2] || '').trim();
      if (raw && !amounts.includes(raw)) amounts.push(raw);
      if (amounts.length >= 6) break;
    }

    // 3. German Dates (DD.MM.YYYY)
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

  /* --- Multi-Page Retina Canvas Renderer (CoinVault-style, zero iframe) --- */
  async function destroyCurrentPdf() {
    activeRenderToken += 1;
    if (currentPdfDoc) {
      try { await currentPdfDoc.destroy(); } catch { /* ignore */ }
      currentPdfDoc = null;
    }
  }

  async function renderAllPagesIntoContainer(uint8Array, container, onPageUpdate) {
    ensureWorker();
    await destroyCurrentPdf();
    const token = activeRenderToken;

    container.innerHTML = `
      <div class="py-12 flex flex-col items-center justify-center gap-2 text-slate-300 text-xs">
        <svg class="w-7 h-7 text-sky-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
        </svg>
        <span>PDF wird gerendert …</span>
      </div>
    `;

    const loadingTask = pdfjsLib.getDocument({ data: uint8Array.slice() });
    const pdf = await loadingTask.promise;
    if (token !== activeRenderToken) {
      try { await pdf.destroy(); } catch { /* ignore */ }
      return null;
    }
    currentPdfDoc = pdf;

    const numPages = pdf.numPages;
    if (typeof onPageUpdate === 'function') {
      onPageUpdate(1, numPages);
    }

    container.innerHTML = '';
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const availableWidth = Math.max(280, Math.min((container.clientWidth || window.innerWidth) - 24, 960));

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      if (token !== activeRenderToken) return null;

      const page = await pdf.getPage(pageNum);
      if (token !== activeRenderToken) return null;

      const baseViewport = page.getViewport({ scale: 1 });
      const cssScale = availableWidth / baseViewport.width;
      const cssWidth = Math.floor(baseViewport.width * cssScale);
      const cssHeight = Math.floor(baseViewport.height * cssScale);
      const renderViewport = page.getViewport({ scale: cssScale * dpr });

      const pageWrap = document.createElement('div');
      pageWrap.className = 'w-full flex flex-col items-center';
      pageWrap.dataset.pageNum = String(pageNum);

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(renderViewport.width);
      canvas.height = Math.floor(renderViewport.height);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      canvas.className = 'max-w-full h-auto bg-white rounded shadow-xl';

      pageWrap.appendChild(canvas);

      if (numPages > 1) {
        const caption = document.createElement('div');
        caption.className = 'mt-1.5 mb-1 text-[11px] text-slate-400 select-none';
        caption.textContent = `Seite ${pageNum} / ${numPages}`;
        pageWrap.appendChild(caption);
      }

      container.appendChild(pageWrap);

      const ctx = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
    }

    // Track current visible page on vertical scroll
    container.onscroll = () => {
      if (numPages <= 1 || typeof onPageUpdate !== 'function') return;
      const children = container.querySelectorAll('[data-page-num]');
      const scrollMid = container.scrollTop + container.clientHeight * 0.35;
      let active = 1;
      for (const el of children) {
        if (el.offsetTop <= scrollMid) {
          active = Number(el.dataset.pageNum) || 1;
        }
      }
      onPageUpdate(active, numPages);
    };

    return { numPages };
  }

  return {
    extractTextAndSuggestions,
    renderAllPagesIntoContainer,
    destroyCurrentPdf
  };
})();
