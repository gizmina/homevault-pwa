/* HomeVault PWA – Offline Bank / Amex / PayPal CSV & PDF Statement Importer (Zero AI API) */
window.HVCsvImporter = (() => {
  'use strict';

  const CATEGORY_RULES = [
    { cat: 'Wohnen & Miete', kws: ['miete', 'wohnungsgenossenschaft', 'stadtwerke', 'strom', 'gas', 'wasser', 'vattenfall', 'e.on', 'eon', 'enbw', 'rundfunk', 'gez', 'hausverwaltung', 'heizung'] },
    { cat: 'Internet & Mobilfunk', kws: ['telekom', 'vodafone', 'o2', 'telefonica', '1&1', 'congstar', 'freenet', 'pyur', 'm-net', 'starlink', 'fraenk', 'sim.de', 'aldi talk'] },
    { cat: 'Versicherung', kws: ['versicherung', 'allianz', 'huk', 'ergo', 'axa', 'debeka', 'devk', 'signal iduna', 'r+v', 'gothaer', 'zurich', 'generali', 'barmenia', 'hansemerkur', 'haftpflicht', 'hausrat', 'rechtsschutz', 'krankenkasse', 'tk ', 'techniker', 'aok', 'barmer'] },
    { cat: 'KFZ & Mobilität', kws: ['adac', 'bahn', 'deutschlandticket', 'db vertrieb', 'leasing', 'kfz', 'finanzamt', 'zoll', 'parken', 'tank', 'vag', 'mvg', 'bvg', 'sixt', 'miles'] },
    { cat: 'Bank & Finanzen', kws: ['ing-diba', 'ing etf', 'dkb', 'sparkasse', 'volksbank', 'commerzbank', 'deutsche bank', 'amex', 'american express', 'trade republic', 'scalable', 'etf', 'wertpapier', 'sparplan', 'depot', 'degussa', 'flexgold', 'kredit', 'darlehen', 'kontoführung', 'isin'] }
  ];

  const KNOWN_RECURRING_HINTS = [
    'netflix', 'spotify', 'disney', 'amazon prime', 'audible', 'apple.com/bill', 'icloud',
    'google one', 'youtube', 'microsoft', 'adobe', 'dropbox', 'fit/one', 'mcfit', 'fitness',
    'miete', 'strom', 'stadtwerke', 'telekom', 'vodafone', 'o2', '1&1', 'congstar',
    'versicherung', 'allianz', 'huk', 'adac', 'rundfunk', 'sparplan', 'wertpapier', 'etf',
    'deutschlandticket', 'db vertrieb', 'grundeinkommen', 'lastschrift', 'dauerauftrag',
    'abo', 'beitrag', 'mitgliedschaft', 'wohnungsgenossenschaft', 'handy', 'dsl', 'glasfaser'
  ];

  const SECURITY_SKIP_WORDS = ['wertpapiergutschrift', 'storno kauf', 'storno-kauf', 'stornokauf'];

  const KNOWN_ETF_BY_ISIN = {
    LU0496786657: 'ING ETF – S&P 500 (LU0496786657)',
    LU1861132840: 'ING ETF – MSCI Robotics & AI (LU1861132840)',
    LU2023678878: 'ING ETF – MSCI Digital Economy (LU2023678878)',
    IE00BM67HT60: 'ING ETF – MSCI World Info Tech (IE00BM67HT60)',
    IE00BJ0KDQ92: 'ING ETF – MSCI World (IE00BJ0KDQ92)'
  };

  const KNOWN_ETF_OCR_FIXES = {
    IEOOBJOKDQ92: 'IE00BJ0KDQ92',
    IE00BJOKDQ92: 'IE00BJ0KDQ92',
    IEOOBJ0KDQ92: 'IE00BJ0KDQ92',
    IEOOBM67HT60: 'IE00BM67HT60',
    IEOOBM67HT6O: 'IE00BM67HT60',
    LUO496786657: 'LU0496786657',
    LU186113284O: 'LU1861132840',
    LU2O23678878: 'LU2023678878'
  };

  const KNOWN_ETF_BY_NAME = [
    { match: /mulacspp500|s&p\s*500/i, isin: 'LU0496786657', label: 'ING ETF – S&P 500 (LU0496786657)' },
    { match: /msci\s*rob\+ai|robotics/i, isin: 'LU1861132840', label: 'ING ETF – MSCI Robotics & AI (LU1861132840)' },
    { match: /msci\s*dig\.?econo|digital\s*econ/i, isin: 'LU2023678878', label: 'ING ETF – MSCI Digital Economy (LU2023678878)' },
    { match: /msci\s*wo\.?in\.?te|world\s*info/i, isin: 'IE00BM67HT60', label: 'ING ETF – MSCI World Info Tech (IE00BM67HT60)' },
    { match: /msci\s*world/i, isin: 'IE00BJ0KDQ92', label: 'ING ETF – MSCI World (IE00BJ0KDQ92)' }
  ];

  const PDF_NOISE_LINES = [
    'alter saldo', 'neuer saldo', 'anfangssaldo', 'endsaldo', 'zwischensumme',
    'kontostand', 'übertrag', 'uebertrag', 'seite ', 'iban ', 'bic ',
    'buchung / verwendungszweck', 'buchungstag', 'valuta', 'betrag (eur)',
    'umsatzübersicht', 'kontoauszug', 'girokonto', 'auszugsnummer', 'kundennummer',
    'zahlung dankend erhalten', 'summe der', 'gesamtsumme', 'sollzinsen', 'habenzinsen'
  ];

  function normalizeIsin(rawIsin) {
    if (!rawIsin) return null;
    let code = String(rawIsin).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 12) return null;
    if (KNOWN_ETF_OCR_FIXES[code]) return KNOWN_ETF_OCR_FIXES[code];
    // Toleranz für typische PDF/OCR-Verwechslung O -> 0 in ISIN-Positionen 2..3 (z. B. IEOO -> IE00, LUO -> LU0)
    const prefix = code.slice(0, 2);
    const body = code.slice(2);
    const fixedBody = body.replace(/^OO/, '00').replace(/^O/, '0');
    const candidate = prefix + fixedBody;
    if (KNOWN_ETF_OCR_FIXES[candidate]) return KNOWN_ETF_OCR_FIXES[candidate];
    if (KNOWN_ETF_BY_ISIN[candidate]) return candidate;
    // Auch wenn O in der Mitte bei bekannten ISINs vorkommt
    const allZeroCandidate = prefix + body.replace(/O/g, '0');
    if (KNOWN_ETF_BY_ISIN[allZeroCandidate]) return allZeroCandidate;
    return candidate;
  }

  function extractSecurityMetadata(merchant, purpose) {
    const combined = `${merchant || ''} ${purpose || ''}`.replace(/\s{2,}/g, ' ').trim();
    const lower = combined.toLowerCase();

    if (SECURITY_SKIP_WORDS.some((sw) => lower.includes(sw))) {
      return { skip: true };
    }

    const isSecurity =
      lower.includes('wertpapierkauf') ||
      lower.includes('wp-abrechnung') ||
      /\bisin\s*[:#]?\s*[a-z]{2}[a-z0-9]{10}\b/i.test(combined);

    if (!isSecurity) return null;

    // ISIN mit OCR-Toleranz extrahieren
    const isinMatch = combined.match(/\bISIN\s*[:#]?\s*([A-Z]{2}[A-Z0-9]{10})\b(?:\s+([^|;\n]{2,65}))?/i);
    let isin = isinMatch ? normalizeIsin(isinMatch[1]) : null;
    let fundSnippet = isinMatch && isinMatch[2] ? isinMatch[2] : '';

    // Rauschen am Ende der Fondsbezeichnung entfernen (Referenz, Depot, Kurse, Zahlenblöcke)
    fundSnippet = fundSnippet
      .replace(/\b(?:Referenz|Ref\.?|Depot|WP-?Abrechnung|Ausführung|Kurs|Stück|Order|Mandat)\b.*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .replace(/^[\-–:|;]+|[\-–:|;]+$/g, '')
      .trim();

    // 1. Exakter Treffer über bekannte ISIN
    if (isin && KNOWN_ETF_BY_ISIN[isin]) {
      const label = KNOWN_ETF_BY_ISIN[isin];
      return {
        isSecurity: true,
        isin,
        provider: label,
        title: label,
        category: 'Bank & Finanzen',
        costType: 'investment',
        groupKey: `isin:${isin}`
      };
    }

    // 2. Treffer über bekannte Fondsbezeichnung (auch falls ISIN im OCR abgeschnitten war)
    for (const rule of KNOWN_ETF_BY_NAME) {
      if (rule.match.test(combined)) {
        const finalIsin = isin || rule.isin;
        const label = KNOWN_ETF_BY_ISIN[finalIsin] || rule.label;
        return {
          isSecurity: true,
          isin: finalIsin,
          provider: label,
          title: label,
          category: 'Bank & Finanzen',
          costType: 'investment',
          groupKey: `isin:${finalIsin}`
        };
      }
    }

    // 3. Allgemeiner Fallback für beliebige andere ISINs
    if (isin) {
      const label = fundSnippet
        ? `Wertpapier-Sparplan (${fundSnippet} – ${isin})`
        : `Wertpapier-Sparplan (${isin})`;
      return {
        isSecurity: true,
        isin,
        provider: label,
        title: label,
        category: 'Bank & Finanzen',
        costType: 'investment',
        groupKey: `isin:${isin}`
      };
    }

    // 4. Wertpapierkauf ohne ISIN -> über WP-Abrechnung / Referenz unterscheiden, nicht zusammenwerfen
    const refMatch = combined.match(/(?:WP-?ABRECHNUNG|Referenz)\s*[:#]?\s*([A-Z0-9\-]{4,32})/i);
    if (refMatch) {
      const ref = refMatch[1].trim();
      const label = `Wertpapier-Sparplan (Ref. ${ref})`;
      return {
        isSecurity: true,
        isin: null,
        provider: label,
        title: label,
        category: 'Bank & Finanzen',
        costType: 'investment',
        groupKey: `wp-ref:${ref.toLowerCase()}`
      };
    }

    return null;
  }

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
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})(?!\d)/);
    if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.$/);
    if (m) {
      const yr = fallbackYear || new Date().getFullYear();
      return `${yr}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
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
      // Spezifischer Gruppierungsschlüssel (z. B. isin:LU0496786657 oder normalizedName)
      // Verhindert, dass mehrere Wertpapierkäufe am selben Tag mit gleichem Betrag zusammengefasst werden!
      const key = tx.groupKey || merchantKey(tx.merchant);
      if (!key || key.length < 2) continue;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          merchant: tx.merchant,
          titleOverride: tx.titleOverride || null,
          categoryOverride: tx.categoryOverride || null,
          costTypeOverride: tx.costTypeOverride || null,
          contractNumber: tx.isin || null,
          isSecurity: !!tx.isSecurity,
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
      const isKnownRecurring = g.isSecurity || KNOWN_RECURRING_HINTS.some((kw) => hay.includes(kw));

      if (count < 2 && !isKnownRecurring && !isSingleMonthStatement) continue;

      const avgAmount = Math.round((g.amounts.reduce((a, b) => a + b, 0) / count) * 100) / 100;
      const minAmt = Math.min(...g.amounts);
      const maxAmt = Math.max(...g.amounts);
      const isVariable = maxAmt - minAmt > Math.max(2.0, avgAmount * 0.08);
      const cycle = inferBillingCycle(uniqueDates);
      const category = g.categoryOverride || guessCategory(g.merchant, samplePurpose);
      const costType = g.costTypeOverride || window.HVSchema.detectInvestmentCostType(g.merchant, samplePurpose, '');

      const title = g.titleOverride
        || (samplePurpose && samplePurpose.toLowerCase() !== g.merchant.toLowerCase()
          ? `${g.merchant} (${samplePurpose.slice(0, 45)})`
          : g.merchant);

      candidates.push({
        id: g.key,
        provider_name: g.merchant,
        title,
        contract_number: g.contractNumber || null,
        category,
        cost_amount: avgAmount,
        billing_cycle: cycle,
        cost_type: costType,
        is_variable: isVariable,
        occurrences: count,
        last_date: uniqueDates.length ? uniqueDates[uniqueDates.length - 1] : null,
        selected: g.isSecurity || count >= 2 || isKnownRecurring
      });
    }

    candidates.sort((a, b) => (b.selected ? 1 : 0) - (a.selected ? 1 : 0) || b.occurrences - a.occurrences || b.cost_amount - a.cost_amount);
    return candidates;
  }

  function enrichTransaction(date, rawMerchant, rawPurpose, amount) {
    const sec = extractSecurityMetadata(rawMerchant, rawPurpose);
    if (sec && sec.skip) return null;
    if (sec && sec.isSecurity) {
      return {
        date,
        merchant: sec.provider,
        titleOverride: sec.title,
        categoryOverride: sec.category,
        costTypeOverride: sec.costType,
        isin: sec.isin,
        isSecurity: true,
        groupKey: sec.groupKey,
        purpose: rawPurpose,
        amount
      };
    }
    const cleanMerchant = normalizeMerchant(rawMerchant) || normalizeMerchant(rawPurpose.slice(0, 50));
    if (!cleanMerchant || cleanMerchant.length < 2) return null;
    return {
      date,
      merchant: cleanMerchant,
      purpose: rawPurpose,
      amount
    };
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
    const colBookingText = findCol(headers, ['buchungstext', 'typ', 'type']);
    const colStatus = findCol(headers, ['status']);

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

      const rawMerchant = String(colMerchant ? (row[colMerchant] || '') : '').trim();
      const rawPurpose = String(colPurpose ? (row[colPurpose] || '') : '').trim();
      const rawBookingText = String(colBookingText ? (row[colBookingText] || '') : '').trim();
      const fullPurpose = [rawBookingText, rawPurpose].filter((v, i, a) => v && a.indexOf(v) === i).join(' ');
      const txDate = parseDateFlexible(colDate ? row[colDate] : '');
      const txStatus = String(colStatus ? (row[colStatus] || '') : '').toLowerCase();
      const combinedLower = `${rawMerchant} ${fullPurpose}`.toLowerCase();

      let expenseAmount = 0;

      if (format === 'amex') {
        if (amount <= 0) continue;
        if (combinedLower.includes('paypal *') || combinedLower.includes('paypal europe')) continue;
        expenseAmount = amount;
      } else if (format === 'paypal') {
        if (amount >= 0) continue;
        if (txStatus.includes('storniert') || txStatus.includes('rückerstattet') || txStatus.includes('abgelehnt')) continue;
        if (rawBookingText.toLowerCase().includes('bankkonto') || rawBookingText.toLowerCase().includes('kreditkarte') || rawBookingText.toLowerCase().includes('allgemeine kartenabbuchung')) continue;
        expenseAmount = Math.abs(amount);
      } else {
        if (amount >= 0) continue;
        if (combinedLower.includes('american express') && combinedLower.includes('abbuchung')) continue;
        expenseAmount = Math.abs(amount);
      }

      const enriched = enrichTransaction(txDate, rawMerchant, fullPurpose, Math.round(expenseAmount * 100) / 100);
      if (enriched) transactions.push(enriched);
    }

    // Check date span for single-month CSVs
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
      sourceType: 'csv',
      format,
      totalRows: rows.length,
      expenseRows: transactions.length,
      candidates
    };
  }

  /* --- PDF Statement Parser (pdf.js Y-Coordinate Row Reconstruction + Multi-line ING Support) --- */
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
      const rows = [];

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

    const yearMatch = lines.slice(0, 40).join(' ').match(/\b(20\d{2})\b/);
    const fallbackYear = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();

    const amountAtEndRe = /(?:EUR|€)?\s*([+\-]?\d{1,3}(?:\.\d{3})*,\d{2}|[+\-]?\d+,\d{2})\s*([+\-SH])?\s*(?:EUR|€)?$/i;
    const leadingDateRe = /^(\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?)\s+(.*)$/;
    const secondDateRe = /^(\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?)\s+(.*)$/;

    const transactions = [];
    let currentTx = null;

    const flushTx = () => {
      if (!currentTx) return;
      const combinedLower = `${currentTx.merchant} ${currentTx.purpose}`.toLowerCase();
      if (!PDF_NOISE_LINES.some((n) => combinedLower.includes(n))) {
        const enriched = enrichTransaction(
          currentTx.date,
          currentTx.merchant,
          currentTx.purpose.trim(),
          currentTx.amount
        );
        if (enriched) transactions.push(enriched);
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
        // Neue Buchung beginnt -> vorherige Buchung inkl. aller Verwendungszweck-Zeilen abschließen
        flushTx();
        const txDate = parseDateFlexible(dateMatch[1], fallbackYear);
        let rest = dateMatch[2];
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
      } else if (currentTx && !amtMatch && rawLine.length >= 2 && rawLine.length <= 180) {
        // Mehrzeilige ING/Sparkasse/DKB-Verwendungszweckzeilen (auch wenn Zeile 2 mit Valuta-Datum beginnt, z. B. "01.10.2026 WP-ABRECHNUNG ... ISIN ...")
        let contText = rawLine;
        if (dateMatch) {
          contText = dateMatch[2].trim();
        }
        if (contText.length >= 2) {
          const isImportantSecurityLine = /ISIN|WP-?ABRECHNUNG|MULAC|MSCI|ETF|Referenz/i.test(contText);
          if (isImportantSecurityLine || !/^(?:Mandat|Gläubiger-?ID|IBAN|BIC)/i.test(contText)) {
            if (
              !isImportantSecurityLine &&
              currentTx.merchant.length < 22 &&
              /^(?:Lastschrift|Dauerauftrag|SEPA|Kartenzahlung|Überweisung)/i.test(currentTx.merchant)
            ) {
              currentTx.merchant = contText;
            } else if (currentTx.purpose.length < 500) {
              currentTx.purpose = currentTx.purpose ? `${currentTx.purpose} ${contText}` : contText;
            }
          }
        }
      }
    }
    flushTx();

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
    parseStatementFile,
    normalizeIsin,
    extractSecurityMetadata
  };
})();
