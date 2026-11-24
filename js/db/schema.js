/* HomeVault PWA – Exact QNAP SQLite Schema, Constants & Helpers */
window.HVSchema = (() => {
  'use strict';

  const CATEGORIES = [
    'Wohnen & Miete',
    'Internet & Mobilfunk',
    'Versicherung',
    'KFZ & Mobilität',
    'Bank & Finanzen',
    'Abos & Sonstiges'
  ];

  const BILLING_CYCLES = ['monthly', 'biweekly', 'quarterly', 'yearly', 'one_time'];

  const BILLING_CYCLE_LABELS = {
    monthly: 'monatlich',
    biweekly: 'Alle 2 Wochen',
    quarterly: 'vierteljährlich',
    yearly: 'jährlich',
    one_time: 'einmalig'
  };

  const STATUS_LABELS = {
    active: 'Aktiv',
    review_needed: 'Zu prüfen',
    cancelled: 'Gekündigt'
  };

  const COST_TYPE_LABELS = {
    expense: 'Fixkosten / Ausgabe',
    investment: 'Investment / Sparplan'
  };

  const INVESTMENT_KEYWORDS = [
    'etf', 'wertpapier', 'sparplan', 'degussa', 'flexgold', 'etoro',
    'trade republic', 'scalable', 'depot', 'goldhandel', 'edelmetall',
    'ishares', 'vanguard', 'xtrackers', 'amundi', 'msci', 'aktien',
    'fonds', 'krypto', 'bitcoin'
  ];

  // Exact QNAP HomeVault SQLite Schema (100% round-trip compatible)
  const CREATE_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username VARCHAR(128) UNIQUE,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL DEFAULT '',
      role VARCHAR(32) NOT NULL DEFAULT 'user',
      password_hash VARCHAR(255),
      created_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category VARCHAR(64) NOT NULL DEFAULT 'Abos & Sonstiges',
      provider_name VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      contract_number VARCHAR(128),
      customer_number VARCHAR(128),
      cost_amount FLOAT NOT NULL DEFAULT 0.0,
      billing_cycle VARCHAR(32) NOT NULL DEFAULT 'monthly',
      monthly_equivalent FLOAT NOT NULL DEFAULT 0.0,
      cost_type VARCHAR(32) NOT NULL DEFAULT 'expense',
      is_variable BOOLEAN NOT NULL DEFAULT 0,
      is_demo BOOLEAN NOT NULL DEFAULT 0,
      start_date DATE,
      end_date DATE,
      notice_period_days INTEGER,
      next_cancellation_deadline DATE,
      emergency_contact TEXT,
      notes TEXT,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      source_email_subject VARCHAR(512),
      source_email_date DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      filename VARCHAR(255) NOT NULL,
      file_path VARCHAR(512) NOT NULL,
      mime_type VARCHAR(128) NOT NULL DEFAULT 'application/pdf',
      extracted_text TEXT,
      uploaded_at DATETIME NOT NULL,
      FOREIGN KEY(contract_id) REFERENCES contracts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mail_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id VARCHAR(512) UNIQUE NOT NULL,
      sender VARCHAR(255) NOT NULL DEFAULT '',
      subject VARCHAR(512) NOT NULL DEFAULT '',
      processed_at DATETIME NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'success',
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS statement_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_hash VARCHAR(64) UNIQUE NOT NULL,
      filename VARCHAR(255) NOT NULL,
      processed_at DATETIME NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'success',
      items_found INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS ix_contracts_category ON contracts(category);
    CREATE INDEX IF NOT EXISTS ix_contracts_status ON contracts(status);
    CREATE INDEX IF NOT EXISTS ix_contracts_is_demo ON contracts(is_demo);
    CREATE INDEX IF NOT EXISTS ix_documents_contract_id ON documents(contract_id);
  `;

  function ensureSchema(db) {
    db.run('PRAGMA foreign_keys = ON;');
    db.run(CREATE_SCHEMA_SQL);

    // Ensure compatibility with older QNAP DBs if columns are missing (non-destructive)
    const contractCols = getTableColumns(db, 'contracts');
    if (contractCols.length > 0) {
      if (!contractCols.includes('cost_type')) {
        db.run("ALTER TABLE contracts ADD COLUMN cost_type VARCHAR(32) NOT NULL DEFAULT 'expense';");
      }
      if (!contractCols.includes('is_variable')) {
        db.run('ALTER TABLE contracts ADD COLUMN is_variable BOOLEAN NOT NULL DEFAULT 0;');
      }
      if (!contractCols.includes('is_demo')) {
        db.run('ALTER TABLE contracts ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT 0;');
      }
    }

    // Seed a default local admin user only if users table is completely empty
    const userCountRes = db.exec('SELECT COUNT(*) FROM users');
    const userCount = userCountRes.length ? Number(userCountRes[0].values[0][0]) : 0;
    if (userCount === 0) {
      const now = nowIsoUtc();
      db.run(
        `INSERT INTO users (username, email, name, role, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['admin', 'admin@homevault.local', 'Haupt-Account', 'admin', null, now]
      );
    }
  }

  function getTableColumns(db, tableName) {
    try {
      const res = db.exec(`PRAGMA table_info(${tableName})`);
      if (!res.length) return [];
      return res[0].values.map((row) => String(row[1]));
    } catch {
      return [];
    }
  }

  function nowIsoUtc() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  function todayIso() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function calculateMonthlyEquivalent(costAmount, billingCycle) {
    const amount = Math.max(0, Number(costAmount) || 0);
    if (billingCycle === 'monthly') return Math.round(amount * 100) / 100;
    if (billingCycle === 'biweekly') return Math.round(((amount * 26) / 12) * 100) / 100;
    if (billingCycle === 'quarterly') return Math.round((amount / 3) * 100) / 100;
    if (billingCycle === 'yearly') return Math.round((amount / 12) * 100) / 100;
    return 0;
  }

  function calculateNextCancellationDeadline(endDateStr, noticePeriodDays, explicitDeadlineStr) {
    if (explicitDeadlineStr && /^\d{4}-\d{2}-\d{2}/.test(explicitDeadlineStr)) {
      return explicitDeadlineStr.slice(0, 10);
    }
    if (endDateStr && /^\d{4}-\d{2}-\d{2}/.test(endDateStr) && noticePeriodDays !== null && noticePeriodDays !== '' && !Number.isNaN(Number(noticePeriodDays))) {
      const days = Math.max(0, parseInt(noticePeriodDays, 10));
      const dt = new Date(`${endDateStr.slice(0, 10)}T00:00:00`);
      if (!Number.isNaN(dt.getTime())) {
        dt.setDate(dt.getDate() - days);
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const d = String(dt.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
    }
    return null;
  }

  function detectInvestmentCostType(providerName, title, notes) {
    const haystack = [providerName, title, notes].filter(Boolean).join(' ').toLowerCase();
    return INVESTMENT_KEYWORDS.some((kw) => haystack.includes(kw)) ? 'investment' : 'expense';
  }

  function parseGermanFloat(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (!value) return 0;
    let s = String(value).trim().replace(/[€\s]/g, '');
    // Handle German format 1.234,56 or 129,00
    if (s.includes(',') && s.includes('.')) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        s = s.replace(/,/g, '');
      }
    } else if (s.includes(',')) {
      s = s.replace(',', '.');
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  function formatGermanDecimal(value) {
    const num = Number(value) || 0;
    return num.toFixed(2).replace('.', ',');
  }

  function formatEur(value) {
    const num = Number(value) || 0;
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(num);
  }

  function formatDateDe(isoStr) {
    if (!isoStr) return '–';
    const clean = String(isoStr).slice(0, 10);
    const parts = clean.split('-');
    if (parts.length !== 3) return clean;
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }

  function daysUntil(isoDateStr) {
    if (!isoDateStr) return null;
    const clean = String(isoDateStr).slice(0, 10);
    const target = new Date(`${clean}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    const today = new Date(`${todayIso()}T00:00:00`);
    return Math.round((target.getTime() - today.getTime()) / 86400000);
  }

  function isContractExpired(contract) {
    if (!contract || !contract.end_date) return false;
    const diff = daysUntil(contract.end_date);
    return diff !== null && diff < 0;
  }

  function isContractActiveForFixedCosts(contract) {
    if (!contract) return false;
    if (contract.status !== 'active') return false;
    if (isContractExpired(contract)) return false;
    return true;
  }

  function queryAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    const rows = [];
    try {
      stmt.bind(params);
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  function queryOne(db, sql, params = []) {
    const rows = queryAll(db, sql, params);
    return rows.length ? rows[0] : null;
  }

  return {
    CATEGORIES,
    BILLING_CYCLES,
    BILLING_CYCLE_LABELS,
    STATUS_LABELS,
    COST_TYPE_LABELS,
    ensureSchema,
    nowIsoUtc,
    todayIso,
    calculateMonthlyEquivalent,
    calculateNextCancellationDeadline,
    detectInvestmentCostType,
    parseGermanFloat,
    formatGermanDecimal,
    formatEur,
    formatDateDe,
    daysUntil,
    isContractExpired,
    isContractActiveForFixedCosts,
    queryAll,
    queryOne
  };
})();
