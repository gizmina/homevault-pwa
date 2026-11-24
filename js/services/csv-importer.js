/* HomeVault PWA – Offline Bank / Amex / PayPal CSV & PDF Statement Importer (Zero AI API) */
window.HVCsvImporter = (() => {
  'use strict';

  const CATEGORY_RULES = [
    { cat: 'Wohnen & Miete', kws: ['miete', 'wohnungsgenossenschaft', 'stadtwerke', 'strom', 'gas', 'wasser', 'vattenfall', 'e.on', 'eon', 'enbw', 'rundfunk', 'gez', 'hausverwaltung', 'heizung'] },
    { cat: 'Internet & Mobilfunk', kws: ['telekom', 'vodafone', 'o2', 'telefonica', '1&1', 'congstar', 'freenet', 'pyur', 'm-net', 'starlink', 'fraenk', 'sim.de', 'aldi talk'] },
    { cat: 'Versicherung', kws: ['versicherung', 'allianz', 'huk', 'ergo', 'axa', 'debeka', 'devk', 'signal iduna', 'r+v', 'gothaer', 'zurich', 'generali', 'barmenia', 'hansemerkur', 'haftpflicht', 'hausrat', 'rechtsschutz', 'krankenkasse', 'tk ', 'techniker', 'aok', 'barmer'] },
    { cat: 'KFZ & Mobilität', kws: ['adac', 'bahn', 'deutschlandticket', 'db vertrieb', 'leasing', 'kfz', 'finanzamt', 'zoll', 'parken', 'tank', 'vag', 'mvg', 'bvg', 'sixt', 'miles'] },
    { cat: 'Bank & Finanzen', kws: ['ing-diba', 'dkb', 'sparkasse', 'volksbank', 'commerzbank', 'deutsche bank', 'amex', 'american express', 'trade republic', 'scalable', 'etf', 'wertpapier', 'sparplan', 'depot', 'degussa', 'flexgold', 'kredit', 'darlehen', 'kontoführung'] }
  ];

  const KNOWN_RECURRING_HINTS = [
    'netflix', 'spotify', 'disney', 'amazon prime', 'audible', 'apple.com/bill', 'icloud',
    'google one', 'youtube', 'microsoft', 'adobe', 'dropbox', 'fit/one', 'mcfit', 'fitness',
    'miete', 'strom', 'stadtwerke', 'telekom', 'vodafone', 'o2', '1&1', 'congstar',
    'versicherung', 'allianz', 'huk', 'adac', 'rundfunk', 'sparplan', 'wertpapier', 'etf',
    'deutschlandticket', 'db vertrieb', 'grundeinkommen', 'lastschrift', 'dauerauftrag',
    'abo', 'beitrag', 'mitgliedschaft', 'wohnungsgenossenschaft', 'handy', 'dsl', 'glasfaser'
  ];

  const PDF_NOISE_LINES = [
    'alter saldo', 'neuer saldo', 'anfangssaldo', 'endsaldo', 'zwischensumme',
    'kontostand', 'übertrag', 'uebertrag', 'seite ', 'iban ', 'bic ',
    'buchung / verwendungszweck', 'buchungstag', 'valuta', 'betrag (eur)',
    'umsatzübersicht', 'kontoauszug', 'girokonto', 'auszugsnummer', 'kundennummer',
    'zahlung dankend erhalten', 'summe der', 'gesamtsumme', 'sollzinsen', 'habenzinsen'
  ];

  function guessCategory(merchant, purpose) {
    const hay = `${merchant} ${purpose}`.toLowerCase();
    for (const rule of CATEGORY_RULES) {
      if (rule.kws.some((kw) => hay.includes(kw))) return rule.cat;
    }
    return 'Abos & Sonstiges';
  }

  function parseDateFlexible(raw, fallbackYear) {
    if (!raw) return null;
    const s = String(raw).trim();
    // DD.MM.YYYY
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    // DD.MM.YY
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})(?!\d)/);
    if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    // DD.MM. (common in Sparkasse / Amex PDFs)
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.$/);
    if (m) {
      const yr = fallbackYear || new Date().getFullYear();
      return `${yr}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    // YYYY-MM-DD
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    // MM/DD/YYYY (Amex US/EN)
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return null;
  }

  function normalizeMerchant(raw) {
    let s = String(raw || '').trim();
    s = s.replace(/^(?:SEPA-?)?(?:Basis-?|Folge-?)?(?:Lastschrift|Dauerauftrag|Überweisung|Ueberweisung|Kartenzahlung|Girocard|Entgeltabrechnung|Abbuchung)\s*[:\-]?\s*/i, '');
    s = s.replace(/\s{2,}/g, ' ');
    s = s.replace(/\b\d{6,}\b/g, '').replace(/\s{2,}/g, ' ').trim();
    if (s.length > 80) s = s.slice(0, 80).trim();
    return s;
  }

  function merchantKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');
  }

  function detectHeaderRowIndex(lines) {
    const headerKeywords = [
      'buchung', 'valuta', 'datum', 'date', 'betrag', 'amount', 'auftraggeber',
      'empfänger', 'beschreibung', 'description', 'verwendungszweck', 'brutto', 'name',
      'umsatz', 'soll', 'haben', 'begünstigter', 'zahlungspflichtiger'
    ];
    for (let i = 0; i < Math.min(lines.length, 35); i++) {
      const lower = lines[i].toLowerCase();
      let hits = 0;
      for (const kw of headerKeywords) {
        if (lower.includes(kw)) hits += 1;
      }
      if (hits >= 2) return i;
    }
    return 0;
  }

  function detectSourceFormat(headers) {
    const joined = headers.map((h) => String(h || '').toLowerCase().trim()).join(' | ');
    if (joined.includes('brutto') && (joined.includes('typ') || joined.includes('transaktionscode'))) {
      return 'paypal';
    }
    if (
      (joined.includes('datum') && joined.includes('beschreibung') && joined.includes('betrag') && !joined.includes('iban')) ||
      (joined.includes('date') && joined.includes('description') && joined.includes('amount'))
    ) {
      return 'amex';
    }
    return 'bank';
  }

  function findCol(headers, candidates) {
    const lowerHeaders = headers.map((h) => String(h || '').toLowerCase().trim());
    for (const cand of candidates) {
      const idx = lowerHeaders.findIndex((h) => h === cand || h.includes(cand));
      if (idx !== -1) return headers[idx];
    }
    return null;
  }

  function inferBillingCycle(sortedIsoDates) {
    if (!sortedIsoDates || sortedIsoDates.length < 2) return 'monthly';
    const diffs = [];
    for (let i = 1; i < sortedIsoDates.length; i++) {
      const d1 = new Date(`${sortedIsoDates[i - 1]}T00:00:00`);
      const d2 = new Date(`${sortedIsoDates[i]}T00:00:00`);
      const days = Math.round((d2 - d1) / 86400000);
      if (days > 0) diffs.push(days);
    }
    if (!diffs.length) return 'monthly';
    diffs.sort((a, b) => a - b);
    const median = diffs[Math.floor(diffs.length / 2)];
    if (median >= 13 && median <= 15) return 'biweekly';
    if (median >= 24 && median <= 38) return 'monthly';
    if (median >= 75 && median <= 105) return 'quarterly';
    if (median >= 330 && median <= 400) return 'yearly';
    return 'monthly';
  }

  function buildCandidatesFromTransactions(transactions, isSingleMonthStatement = false) {
    const groups = new Map();
    for (const tx of transactions) {
      const key = merchantKey(tx.merchant);
      if (!key || key.length < 2) continue;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          merchant: tx.merchant,
          purposes: new Set(),
          dates: [],
          amounts: []
        });
      }
      const g = groups.get(key);
      if (tx.purpose) g.purposes.add(tx.purpose);
      if (tx.date) g.dates.push(tx.date);
      g.amounts.push(tx.amount);
    }

    const candidates = [];
    for (const g of groups.values()) {
      const uniqueDates = Array.from(new Set(g.dates)).sort();
      const count = g.amounts.length;
      const samplePurpose = Array.from(g.purposes)[0] || '';
      const hay = `${g.merchant} ${samplePurpose}`.toLowerCase();
      const isKnownRecurring = KNOWN_RECURRING_HINTS.some((kw) => hay.includes(kw));

      // Keep if recurring (>=2 bookings) OR matches known recurring provider OR single-month PDF statement
      if (count < 2 && !isKnownRecurring && !isSingleMonthStatement) continue;

      const avgAmount = Math.round((g.amounts.reduce((a, b) => a + b, 0) / count) * 100) / 100;
      const minAmt = Math.min(...g.amounts);
      const maxAmt = Math.max(...g.amounts);
      const isVariable = maxAmt - minAmt > Math.max(2.0, avgAmount * 0.08);
      const cycle = inferBillingCycle(uniqueDates);
      const category = guessCategory(g.merchant, samplePurpose);
      const costType = window.HVSchema.detectInvestmentCostType(g.merchant, samplePurpose, '');

      candidates.push({
        id: g.key,
        provider_name: g.merchant,
        title: samplePurpose && samplePurpose.toLowerCase() !== g.merchant.toLowerCase()
          ? `${g.merchant} (${samplePurpose.slice(0, 45)})`
          : g.merchant,
        category,
        cost_amount: avgAmount,
        billing_cycle: cycle,
        cost_type: costType,
        is_variable: isVariable,
        occurrences: count,
        last_date: uniqueDates.length ? uniqueDates[uniqueDates.length - 1] : null,
        selected: count >= 2 || isKnownRecurring
      });
    }

    candidates.sort((a, b) => (b.selected ? 1 : 0) - (a.selected ? 1 : 0) || b.occurrences - a.occurrences || b.cost_amount - a.cost_amount);
    return candidates;
  }

  /* --- CSV Parser (PapaParse) --- */
  async function parseCsvFile(file) {
    if (typeof Papa === 'undefined') {
      throw new Error('PapaParse ist nicht geladen.');
    }

    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('\uFFFD')) {
      text = new TextDecoder('iso-8859-1').decode(buf);
    }

    const lines = text.split(/\r?\n/);
    const headerIdx = detectHeaderRowIndex(lines);
    const trimmedCsv = lines.slice(headerIdx).join('\n');

    // Auto-detect delimiter (semicolon is standard in German bank exports)
    const sampleHeader = lines[headerIdx] || '';
    const semiCount = (sampleHeader.match(/;/g) || []).length;
    const commaCount = (sampleHeader.match(/,/g) || []).length;
    const delimiter = semiCount >= commaCount && semiCount > 0 ? ';' : '';

    const parsed = Papa.parse(trimmedCsv, {
      header: true,
      delimiter,
      skipEmptyLines: true,
      dynamicTyping: false
    });

    const rows = parsed.data || [];
    const headers = parsed.meta && parsed.meta.fields ? parsed.meta.fields : [];
    if (!headers.length || !rows.length) {
      throw new Error('Keine gültigen CSV-Zeilen gefunden.');
    }

    const format = detectSourceFormat(headers);
    const colDate = findCol(headers, ['buchungstag', 'buchungsdatum', 'buchung', 'datum', 'date', 'valuta', 'wertstellung']);
    const colAmount = findCol(headers, ['betrag', 'umsatz', 'amount', 'brutto']);
    const colSoll = findCol(headers, ['soll', 'ausgabe', 'belastung']);
    const colHaben = findCol(headers, ['haben', 'einnahme', 'gutschrift']);
    const colSollHabenFlag = findCol(headers, ['soll/haben', 's/h']);
    const colMerchant = findCol(headers, [
      'auftraggeber/empfänger', 'begünstigter/zahlungspflichtiger', 'empfänger',
      'auftraggeber', 'begünstigter', 'name', 'beschreibung', 'description'
    ]);
    const colPurpose = findCol(headers, ['verwendungszweck', 'buchungstext', 'typ', 'artikelbezeichnung', 'beschreibung', 'description']);
    const colStatus = findCol(headers, ['status']);
    const colType = findCol(headers, ['typ', 'type', 'buchungstext']);

    if (!colAmount && !colSoll) {
      throw new Error('Betragsspalte konnte in der CSV nicht erkannt werden.');
    }

    const transactions = [];

    for (const row of rows) {
      let amount = 0;
      if (colAmount && row[colAmount] !== undefined && String(row[colAmount]).trim() !== '') {
        amount = window.HVSchema.parseGermanFloat(row[colAmount]);
        if (colSollHabenFlag) {
          const sh = String(row[colSollHabenFlag] || '').trim().toUpperCase();
          if (sh === 'S' && amount > 0) amount = -amount;
          if (sh === 'H' && amount < 0) amount = Math.abs(amount);
        }
      } else if (colSoll && row[colSoll] !== undefined && String(row[colSoll]).trim() !== '') {
        const sVal = window.HVSchema.parseGermanFloat(row[colSoll]);
        amount = sVal > 0 ? -sVal : sVal;
      } else if (colHaben && row[colHaben] !== undefined && String(row[colHaben]).trim() !== '') {
        continue;
      }

      if (amount === 0) continue;

      const merchant = normalizeMerchant(colMerchant ? row[colMerchant] : '');
      const purpose = String(colPurpose ? (row[colPurpose] || '') : '').trim();
      const txDate = parseDateFlexible(colDate ? row[colDate] : '');
      const txStatus = String(colStatus ? (row[colStatus] || '') : '').toLowerCase();
      const txType = String(colType ? (row[colType] || '') : '').toLowerCase();
      const combinedLower = `${merchant} ${purpose} ${txType}`.toLowerCase();

      let expenseAmount = 0;

      if (format === 'amex') {
        if (amount <= 0) continue;
        if (combinedLower.includes('paypal *') || combinedLower.includes('paypal europe')) continue;
        expenseAmount = amount;
      } else if (format === 'paypal') {
        if (amount >= 0) continue;
        if (txStatus.includes('storniert') || txStatus.includes('rückerstattet') || txStatus.includes('abgelehnt')) continue;
        if (txType.includes('bankkonto') || txType.includes('kreditkarte') || txType.includes('allgemeine kartenabbuchung')) continue;
        expenseAmount = Math.abs(amount);
      } else {
        if (amount >= 0) continue;
        if (combinedLower.includes('american express') && combinedLower.includes('abbuchung')) continue;
        expenseAmount = Math.abs(amount);
      }

      if (!merchant && !purpose) continue;
      transactions.push({
        date: txDate,
        merchant: merchant || purpose.slice(0, 50),
        purpose,
        amount: Math.round(expenseAmount * 100) / 100
      });
    }

    const candidates = buildCandidatesFromTransactions(transactions, false);
    return {
      sourceType: 'csv',
      format,
      totalRows: rows.length,
      expenseRows: transactions.length,
      candidates
    };
  }

  /* --- PDF Statement Parser (pdf.js Y-Coordinate Row Reconstruction) --- */
  async function extractPdfTableLines(uint8Array) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('pdf.js ist nicht geladen.');
    }
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.js';
    }

    const pdf = await pdfjsLib.getDocument({ data: uint8Array.slice() }).promise;
    const maxPages = Math.min(pdf.numPages, 60);
    const allLines = [];

    for (let p = 1; p <= maxPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const rows = []; // [{ y, items: [{ x, str }] }]

      for (const item of content.items) {
        const str = (item.str || '').trim();
        if (!str) continue;
        const x = item.transform ? item.transform[4] : 0;
        const y = item.transform ? item.transform[5] : 0;

        let targetRow = rows.find((r) => Math.abs(r.y - y) <= 3.0);
        if (!targetRow) {
          targetRow = { y, items: [] };
          rows.push(targetRow);
        }
        targetRow.items.push({ x, str });
      }

      // Top-to-bottom (descending Y), left-to-right (ascending X)
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        const lineText = r.items.map((it) => it.str).join(' ').replace(/\s{2,}/g, ' ').trim();
        if (lineText) allLines.push(lineText);
      }
    }

    return { lines: allLines, numPages: pdf.numPages };
  }

  async function parsePdfStatementFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { lines, numPages } = await extractPdfTableLines(bytes);
    if (!lines.length) {
      throw new Error('Aus dem PDF konnte kein Text extrahiert werden (evtl. reiner Bild-Scan).');
    }

    const fullLower = lines.slice(0, 80).join(' ').toLowerCase();
    let format = 'bank';
    if (fullLower.includes('american express') || fullLower.includes('amex')) {
      format = 'amex';
    } else if (fullLower.includes('paypal')) {
      format = 'paypal';
    }

    // Infer statement year if dates omit year (e.g. DD.MM.)
    const yearMatch = lines.slice(0, 40).join(' ').match(/\b(20\d{2})\b/);
    const fallbackYear = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();

    // Regex for German amounts at end of a booking line (e.g. -49,99 | 49,99- | 1.234,56 S | -1.234,56 EUR | 19,99 €)
    const amountAtEndRe = /(?:EUR|€)?\s*([+\-]?\d{1,3}(?:\.\d{3})*,\d{2}|[+\-]?\d+,\d{2})\s*([+\-SH])?\s*(?:EUR|€)?$/i;
    const leadingDateRe = /^(\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?)\s+(.*)$/;
    const secondDateRe = /^(\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?)\s+(.*)$/;

    const transactions = [];
    let currentTx = null;

    const flushTx = () => {
      if (!currentTx) return;
      const combinedLower = `${currentTx.merchant} ${currentTx.purpose}`.toLowerCase();
      if (!PDF_NOISE_LINES.some((n) => combinedLower.includes(n))) {
        const cleanMerchant = normalizeMerchant(currentTx.merchant);
        if (cleanMerchant.length >= 2) {
          transactions.push({
            date: currentTx.date,
            merchant: cleanMerchant,
            purpose: currentTx.purpose.trim(),
            amount: currentTx.amount
          });
        }
      }
      currentTx = null;
    };

    for (const rawLine of lines) {
      const lower = rawLine.toLowerCase();
      if (PDF_NOISE_LINES.some((n) => lower.includes(n))) {
        flushTx();
        continue;
      }

      const dateMatch = rawLine.match(leadingDateRe);
      const amtMatch = rawLine.match(amountAtEndRe);

      if (dateMatch && amtMatch) {
        flushTx();
        const txDate = parseDateFlexible(dateMatch[1], fallbackYear);
        let rest = dateMatch[2];
        // Strip optional second date (Valuta) immediately following Buchungstag
        const valutaMatch = rest.match(secondDateRe);
        if (valutaMatch) rest = valutaMatch[2];

        const desc = rest.slice(0, rest.length - amtMatch[0].length).trim();
        let val = window.HVSchema.parseGermanFloat(amtMatch[1]);
        const suffix = (amtMatch[2] || '').toUpperCase();
        if (suffix === '-' || suffix === 'S') val = -Math.abs(val);
        if (suffix === '+' || suffix === 'H') val = Math.abs(val);

        let isExpense = false;
        let expenseAmount = 0;
        const descLower = desc.toLowerCase();

        if (format === 'amex') {
          if (val > 0 && !descLower.includes('paypal *') && !descLower.includes('paypal europe') && !descLower.includes('gutschrift')) {
            isExpense = true;
            expenseAmount = val;
          }
        } else {
          if (val < 0 && !(descLower.includes('american express') && descLower.includes('abbuchung'))) {
            isExpense = true;
            expenseAmount = Math.abs(val);
          }
        }

        if (isExpense && expenseAmount > 0 && desc.length >= 2) {
          currentTx = {
            date: txDate,
            merchant: desc,
            purpose: '',
            amount: Math.round(expenseAmount * 100) / 100
          };
        }
      } else if (currentTx && !dateMatch && !amtMatch && rawLine.length >= 3 && rawLine.length <= 120) {
        // Continuation line of booking description (merchant/purpose in ING/Sparkasse/DKB PDFs)
        if (!/^(?:Mandat|Referenz|Gläubiger-?ID|IBAN|BIC|Kundenreferenz)/i.test(rawLine)) {
          if (currentTx.merchant.length < 22 && /^(?:Lastschrift|Dauerauftrag|SEPA|Kartenzahlung|Überweisung)/i.test(currentTx.merchant)) {
            currentTx.merchant = rawLine;
          } else if (currentTx.purpose.length < 140) {
            currentTx.purpose = currentTx.purpose ? `${currentTx.purpose} ${rawLine}` : rawLine;
          }
        }
      }
    }
    flushTx();

    // Check date span: if statement covers <= 45 days (e.g. 1 monthly PDF statement), include single-occurrence expenses too
    const uniqueDates = transactions.map((t) => t.date).filter(Boolean).sort();
    let isSingleMonth = false;
    if (uniqueDates.length >= 2) {
      const spanDays = Math.round((new Date(`${uniqueDates[uniqueDates.length - 1]}T00:00:00`) - new Date(`${uniqueDates[0]}T00:00:00`)) / 86400000);
      isSingleMonth = spanDays <= 45;
    } else if (uniqueDates.length === 1) {
      isSingleMonth = true;
    }

    const candidates = buildCandidatesFromTransactions(transactions, isSingleMonth);
    return {
      sourceType: 'pdf',
      format,
      numPages,
      totalRows: lines.length,
      expenseRows: transactions.length,
      candidates
    };
  }

  /* --- Unified Statement Entry Point (.csv & .pdf) --- */
  async function parseStatementFile(file) {
    if (!file) throw new Error('Keine Datei ausgewählt.');
    const name = String(file.name || '').toLowerCase();
    const mime = String(file.type || '').toLowerCase();

    if (name.endsWith('.pdf') || mime === 'application/pdf') {
      return parsePdfStatementFile(file);
    }
    if (name.endsWith('.csv') || mime.includes('csv') || mime === 'text/plain') {
      return parseCsvFile(file);
    }
    throw new Error('Bitte eine .csv- oder .pdf-Datei auswählen.');
  }

  return {
    parseCsvFile,
    parsePdfStatementFile,
    parseStatementFile
  };
})();
