/* HomeVault PWA – Offline Bank / Amex / PayPal CSV Importer (PapaParse, Zero AI API) */
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
    'deutschlandticket', 'db vertrieb', 'grundeinkommen'
  ];

  function guessCategory(merchant, purpose) {
    const hay = `${merchant} ${purpose}`.toLowerCase();
    for (const rule of CATEGORY_RULES) {
      if (rule.kws.some((kw) => hay.includes(kw))) return rule.cat;
    }
    return 'Abos & Sonstiges';
  }

  function parseDateFlexible(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    // DD.MM.YYYY
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) {
      return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    // YYYY-MM-DD
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    // MM/DD/YYYY (Amex US/EN)
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    return null;
  }

  function normalizeMerchant(raw) {
    let s = String(raw || '').trim();
    s = s.replace(/\s{2,}/g, ' ');
    // Strip common trailing reference numbers or dates
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
      .slice(0, 3)
      .join(' ');
  }

  function detectHeaderRowIndex(lines) {
    const headerKeywords = [
      'buchung', 'valuta', 'datum', 'date', 'betrag', 'amount', 'auftraggeber',
      'empfänger', 'beschreibung', 'description', 'verwendungszweck', 'brutto', 'name'
    ];
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
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

  async function parseCsvFile(file) {
    if (typeof Papa === 'undefined') {
      throw new Error('PapaParse ist nicht geladen.');
    }

    // Try UTF-8 first, fallback to ISO-8859-1 if replacement chars appear
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('\uFFFD')) {
      text = new TextDecoder('iso-8859-1').decode(buf);
    }

    const lines = text.split(/\r?\n/);
    const headerIdx = detectHeaderRowIndex(lines);
    const trimmedCsv = lines.slice(headerIdx).join('\n');

    const parsed = Papa.parse(trimmedCsv, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false
    });

    const rows = parsed.data || [];
    const headers = parsed.meta && parsed.meta.fields ? parsed.meta.fields : [];
    if (!headers.length || !rows.length) {
      throw new Error('Keine gültigen CSV-Zeilen gefunden.');
    }

    const format = detectSourceFormat(headers);
    const colDate = findCol(headers, ['buchung', 'datum', 'date', 'valuta', 'wertstellung']);
    const colAmount = findCol(headers, ['betrag', 'amount', 'brutto', 'umsatz']);
    const colMerchant = findCol(headers, ['auftraggeber/empfänger', 'empfänger', 'auftraggeber', 'name', 'beschreibung', 'description', 'begünstigter']);
    const colPurpose = findCol(headers, ['verwendungszweck', 'buchungstext', 'typ', 'artikelbezeichnung', 'beschreibung', 'description']);
    const colStatus = findCol(headers, ['status']);
    const colType = findCol(headers, ['typ', 'type', 'buchungstext']);

    if (!colAmount) {
      throw new Error('Betragsspalte konnte in der CSV nicht erkannt werden.');
    }

    const transactions = [];

    for (const row of rows) {
      const rawAmount = row[colAmount];
      if (rawAmount === undefined || rawAmount === null || String(rawAmount).trim() === '') continue;

      const amount = window.HVSchema.parseGermanFloat(rawAmount);
      if (amount === 0) continue;

      const merchant = normalizeMerchant(colMerchant ? row[colMerchant] : '');
      const purpose = String(colPurpose ? (row[colPurpose] || '') : '').trim();
      const txDate = parseDateFlexible(colDate ? row[colDate] : '');
      const txStatus = String(colStatus ? (row[colStatus] || '') : '').toLowerCase();
      const txType = String(colType ? (row[colType] || '') : '').toLowerCase();
      const combinedLower = `${merchant} ${purpose} ${txType}`.toLowerCase();

      let expenseAmount = 0;

      if (format === 'amex') {
        // Amex: positive values = expenses; negative = payments/credits
        if (amount <= 0) continue;
        // Skip PayPal pass-throughs on Amex to avoid duplicates
        if (combinedLower.includes('paypal *') || combinedLower.includes('paypal europe')) continue;
        expenseAmount = amount;
      } else if (format === 'paypal') {
        // PayPal: negative values = expenses; skip cancelled/bank-funding pass-throughs
        if (amount >= 0) continue;
        if (txStatus.includes('storniert') || txStatus.includes('rückerstattet') || txStatus.includes('abgelehnt')) continue;
        if (txType.includes('bankkonto') || txType.includes('kreditkarte') || txType.includes('allgemeine kartenabbuchung')) continue;
        expenseAmount = Math.abs(amount);
      } else {
        // Bank (ING, Sparkasse, DKB, etc.): negative values = expenses
        if (amount >= 0) continue;
        // Skip credit card settlement / PayPal pass-through if generic
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

    // Group by normalized merchant key
    const groups = new Map();
    for (const tx of transactions) {
      const key = merchantKey(tx.merchant);
      if (!key) continue;
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

      // Keep if recurring (>=2 bookings) OR matches known recurring provider
      if (count < 2 && !isKnownRecurring) continue;

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
        title: samplePurpose ? `${g.merchant} (${samplePurpose.slice(0, 45)})` : g.merchant,
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

    candidates.sort((a, b) => b.occurrences - a.occurrences || b.cost_amount - a.cost_amount);

    return {
      format,
      totalRows: rows.length,
      expenseRows: transactions.length,
      candidates
    };
  }

  return {
    parseCsvFile
  };
})();
