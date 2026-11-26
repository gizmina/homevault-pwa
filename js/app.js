/* HomeVault PWA – 1:1 QNAP UI Controller backed by local SQLite-WASM & StorageManager */
(() => {
  'use strict';

  const {
    CATEGORIES,
    BILLING_CYCLE_LABELS,
    ensureSchema,
    nowIsoUtc,
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
  } = window.HVSchema;

  const Storage = window.HVStorageManager;
  const Backup = window.HVBackupService;
  const PdfSvc = window.HVPdfService;
  const CsvSvc = window.HVCsvImporter;
  const ContactsSvc = window.HVEmergencyContacts;

  let SQL = null;
  let db = null;
  let demoMode = false;
  let emergencyMode = localStorage.getItem('hv_emergency_mode') === 'true';

  // Active dashboard filters (1:1 QNAP)
  let selectedCategory = 'all';
  let selectedStatus = 'all';
  let selectedCostType = 'all';
  let searchQuery = '';

  // Transient UI state
  let currentView = 'loading'; // loading | setup | permission | dashboard | form | settings
  let pendingZipAction = null; // setup_restore | opfs_restore | settings_pick
  let pendingSettingsZipFile = null;
  let pendingNewPdfs = []; // [{ filename, bytes, extractedText }]
  let csvCandidates = [];
  let currentPreviewDoc = null; // { filename, bytes, blobUrl }
  let activeContactSuggestion = null;
  let deferredInstallPrompt = null;
  let toastTimer = null;
  let lastEditedContractId = null;
  let isResetting = false;

  const $ = (id) => document.getElementById(id);

  /* --- Global QNAP-compatible Helpers (Theme, Toast, Copy, Sticky Offsets) --- */
  window.hvToggleTheme = function () {
    const html = document.documentElement;
    if (html.classList.contains('dark')) {
      html.classList.remove('dark');
      localStorage.setItem('hv_theme', 'light');
    } else {
      html.classList.add('dark');
      localStorage.setItem('hv_theme', 'dark');
    }
  };

  window.hvToast = function (message, type = 'info') {
    const wrap = $('hvToastWrap');
    const box = $('hvToastBox');
    const msg = $('hvToastMsg');
    if (!wrap || !box || !msg) return;
    msg.textContent = message;
    box.className = 'px-4 py-3 rounded-xl shadow-lg text-sm font-medium flex items-center gap-2.5 ' + (
      type === 'success'
        ? 'bg-emerald-600 text-white'
        : type === 'error'
          ? 'bg-rose-600 text-white'
          : 'bg-slate-800 text-white dark:bg-slate-700'
    );
    wrap.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => wrap.classList.add('hidden'), 3500);
  };

  window.hvCopy = async function (text, label = 'Wert') {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      window.hvToast(`${label} kopiert: ${text}`, 'success');
    } catch {
      window.hvToast('Kopieren fehlgeschlagen', 'error');
    }
  };

  function hvSyncStickyOffsets() {
    const header = $('hv-app-header');
    const filter = $('hv-sticky-filter');
    const headerH = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
    const filterH = filter ? Math.ceil(filter.getBoundingClientRect().height) : 0;
    const root = document.documentElement;
    root.style.setProperty('--hv-header-h', `${headerH}px`);
    root.style.setProperty('--hv-sticky-total-h', `${headerH + filterH}px`);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* --- Service Worker & PWA Install --- */
  function registerServiceWorker() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
    }
  }

  function isStandalonePwa() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isSafariBrowser() {
    const ua = navigator.userAgent || '';
    return /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Brave|Firefox|FxiOS|CriOS/i.test(ua);
  }

  function initPwaInstall() {
    const btnDesk = $('btnInstallPwa');
    const btnMob = $('btnInstallPwaMobile');
    if (isStandalonePwa()) return;

    const showInstallBtns = () => {
      if (btnDesk) btnDesk.classList.remove('hidden');
      if (btnMob) btnMob.classList.remove('hidden');
    };
    const hideInstallBtns = () => {
      if (btnDesk) btnDesk.classList.add('hidden');
      if (btnMob) btnMob.classList.add('hidden');
    };

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      showInstallBtns();
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      hideInstallBtns();
      window.hvToast('HomeVault wurde als App installiert.', 'success');
    });

    if (isSafariBrowser()) {
      showInstallBtns();
    }

    const handleInstallClick = async () => {
      $('mobileMenuDrawer').classList.add('hidden');
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        try {
          const choice = await deferredInstallPrompt.userChoice;
          if (choice && choice.outcome === 'accepted') hideInstallBtns();
        } catch { /* ignore */ }
        deferredInstallPrompt = null;
      } else {
        $('safariInstallModal').classList.remove('hidden');
      }
    };

    if (btnDesk) btnDesk.addEventListener('click', handleInstallClick);
    if (btnMob) btnMob.addEventListener('click', handleInstallClick);
  }

  /* --- Screen & View Switching --- */
  function showView(name) {
    currentView = name;
    $('loadingScreen').classList.toggle('hidden', name !== 'loading');
    $('setupScreen').classList.toggle('hidden', name !== 'setup');
    $('permissionScreen').classList.toggle('hidden', name !== 'permission');
    $('dashboardView').classList.toggle('hidden', name !== 'dashboard');
    $('contractFormView').classList.toggle('hidden', name !== 'form');
    $('settingsView').classList.toggle('hidden', name !== 'settings');

    const inApp = name === 'dashboard' || name === 'form' || name === 'settings';
    $('navDesktopAppActions').classList.toggle('hidden', !inApp);
    $('navDesktopAppActions').classList.toggle('flex', inApp);
    $('navDesktopSettingsWrap').classList.toggle('hidden', !inApp);
    $('navDesktopSettingsWrap').classList.toggle('flex', inApp);
    $('btnNewContractMobile').classList.toggle('hidden', !inApp);
    $('btnMobileMenuToggle').classList.toggle('hidden', !inApp);
    $('mobileMenuDrawer').classList.add('hidden');

    if (inApp) {
      setTimeout(hvSyncStickyOffsets, 30);
    }
  }

  function updateSyncPill({ state, message, mode, folderName }) {
    const pill = $('syncPill');
    const dot = $('syncDot');
    const text = $('syncPillText');
    if (!pill || !dot || !text) return;
    pill.classList.remove('hidden');
    if (state === 'saving') {
      dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse';
      text.textContent = message || 'Speichere...';
    } else if (state === 'error') {
      dot.className = 'w-1.5 h-1.5 rounded-full bg-rose-500';
      text.textContent = message || 'Speicherfehler';
    } else {
      dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
      text.textContent = mode === 'opfs' ? 'OPFS · Gespeichert' : `${folderName || 'Ordner'} · Gespeichert`;
    }
  }

  /* --- SQL.js & DB Lifecycle --- */
  async function initSqlEngine() {
    if (SQL) return SQL;
    SQL = await initSqlJs({
      locateFile: (file) => `./vendor/sqljs/${file}`
    });
    return SQL;
  }

  async function openOrCreateDatabaseFromStorage() {
    await initSqlEngine();
    const existingBytes = await Storage.readDatabaseBytes();
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    if (existingBytes && existingBytes.length > 0) {
      db = new SQL.Database(existingBytes);
      ensureSchema(db);
    } else {
      db = new SQL.Database();
      ensureSchema(db);
      await Storage.writeDatabaseBytesAtomic(db.export());
    }

    const info = Storage.getInfo();
    updateSyncPill({ state: 'saved', mode: info.mode, folderName: info.folderName });

    demoMode = false;
    $('toggleDemoMode').checked = false;
    showView('dashboard');
    renderDashboard();
  }

  function persistDebounced() {
    if (!db) return;
    Storage.scheduleSave(() => db.export());
  }

  /* --- Queries --- */
  function getAllContractsForCurrentProfile() {
    if (!db) return [];
    const flag = demoMode ? 1 : 0;
    const contracts = queryAll(
      db,
      `SELECT * FROM contracts WHERE COALESCE(is_demo, 0) = ? ORDER BY category ASC, provider_name ASC, title ASC`,
      [flag]
    );
    const docs = queryAll(db, `SELECT * FROM documents ORDER BY uploaded_at DESC`);
    const docsByContract = new Map();
    for (const d of docs) {
      if (!docsByContract.has(d.contract_id)) docsByContract.set(d.contract_id, []);
      docsByContract.get(d.contract_id).push(d);
    }
    for (const c of contracts) {
      c.documents = docsByContract.get(c.id) || [];
    }
    return contracts;
  }

  /* --- Dashboard Rendering (1:1 QNAP dashboard.html) --- */
  function renderDashboard() {
    const allContracts = getAllContractsForCurrentProfile();

    // Brand badges
    $('brandBadgeDemo').classList.toggle('hidden', !demoMode);
    $('brandBadgeMain').classList.toggle('hidden', demoMode);

    // KPIs (excluding expired contracts from active fixed costs!)
    const activeContracts = allContracts.filter((c) => isContractActiveForFixedCosts(c));
    const activeExpenses = activeContracts.filter((c) => (c.cost_type || 'expense') === 'expense');
    const activeInvestments = activeContracts.filter((c) => c.cost_type === 'investment');
    const reviewContracts = allContracts.filter((c) => c.status === 'review_needed');
    const upcomingDeadlines = allContracts.filter((c) => {
      if (c.status === 'cancelled' || !c.next_cancellation_deadline) return false;
      const d = daysUntil(c.next_cancellation_deadline);
      return d !== null && d <= 60;
    });

    const totalMonthlyExp = activeExpenses.reduce((s, c) => s + (Number(c.monthly_equivalent) || 0), 0);
    const totalMonthlyInv = activeInvestments.reduce((s, c) => s + (Number(c.monthly_equivalent) || 0), 0);

    const kpis = {
      total_monthly: totalMonthlyExp,
      total_yearly: totalMonthlyExp * 12,
      total_monthly_investments: totalMonthlyInv,
      total_yearly_investments: totalMonthlyInv * 12,
      total_monthly_cashflow: totalMonthlyExp + totalMonthlyInv,
      active_count: activeContracts.length,
      investment_count: activeInvestments.length,
      review_count: reviewContracts.length,
      upcoming_deadlines_count: upcomingDeadlines.length
    };

    // Update status dropdown count
    $('optReviewNeeded').textContent = `Zu prüfen (${kpis.review_count})`;
    $('filterStatus').value = selectedStatus;

    // Emergency toggle state
    const btnEm = $('btnEmergencyToggle');
    const lblEm = $('btnEmergencyLabel');
    if (emergencyMode) {
      btnEm.className = 'inline-flex items-center justify-center gap-1.5 md:gap-2 px-2.5 md:px-4 py-1.5 md:py-2.5 rounded-xl text-xs sm:text-sm font-semibold border transition shrink-0 bg-rose-600 text-white border-rose-500 shadow-sm';
      lblEm.textContent = 'Notfall: AN';
      $('emergencyBanner').classList.remove('hidden');
    } else {
      btnEm.className = 'inline-flex items-center justify-center gap-1.5 md:gap-2 px-2.5 md:px-4 py-1.5 md:py-2.5 rounded-xl text-xs sm:text-sm font-semibold border transition shrink-0 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-300 dark:border-slate-700';
      lblEm.textContent = 'Notfall-Ansicht';
      $('emergencyBanner').classList.add('hidden');
    }

    // Category summary helper
    const summarizeCategory = (catName) => {
      const catItems = allContracts.filter((c) => c.category === catName);
      const act = catItems.filter((c) => isContractActiveForFixedCosts(c));
      const exp = act.filter((c) => (c.cost_type || 'expense') === 'expense').reduce((s, c) => s + (Number(c.monthly_equivalent) || 0), 0);
      const inv = act.filter((c) => c.cost_type === 'investment').reduce((s, c) => s + (Number(c.monthly_equivalent) || 0), 0);
      const rev = catItems.filter((c) => c.status === 'review_needed').length;
      return {
        name: catName,
        active_count: act.length,
        monthly_expenses: exp,
        monthly_investments: inv,
        monthly_total: exp + inv,
        yearly_total: (exp + inv) * 12,
        review_count: rev
      };
    };

    // Render Hero KPIs (1:1 QNAP dashboard.html)
    renderHeroKpis(kpis, selectedCategory !== 'all' ? summarizeCategory(selectedCategory) : null);

    // Render Category Pills (1:1 QNAP dashboard.html)
    renderCategoryPills();

    // Filter contracts
    const filtered = allContracts.filter((c) => {
      if (selectedCategory !== 'all' && c.category !== selectedCategory) return false;
      if (selectedCostType !== 'all' && (c.cost_type || 'expense') !== selectedCostType) return false;

      if (selectedStatus !== 'all') {
        const expired = isContractExpired(c);
        if (selectedStatus === 'active') {
          if (c.status !== 'active' || expired) return false;
        } else if (selectedStatus === 'expired') {
          if (!expired) return false;
        } else if (selectedStatus === 'upcoming_deadline') {
          const d = daysUntil(c.next_cancellation_deadline);
          if (c.status === 'cancelled' || d === null || d > 60) return false;
        } else if (c.status !== selectedStatus) {
          return false;
        }
      }

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const docText = (c.documents || []).map((d) => `${d.filename} ${d.extracted_text || ''}`).join(' ');
        const corpus = [
          c.provider_name, c.title, c.category, c.contract_number,
          c.customer_number, c.emergency_contact, c.notes, docText
        ].filter(Boolean).join(' ').toLowerCase();
        if (!corpus.includes(q)) return false;
      }
      return true;
    });

    // Group by QNAP CATEGORIES order
    const grouped = new Map();
    for (const cat of CATEGORIES) {
      const items = filtered.filter((c) => c.category === cat);
      if (items.length) grouped.set(cat, items);
    }
    const otherItems = filtered.filter((c) => !CATEGORIES.includes(c.category));
    if (otherItems.length) grouped.set('Sonstiges', otherItems);

    renderGroupedCards(grouped, summarizeCategory);
    setTimeout(hvSyncStickyOffsets, 20);
  }

  function renderHeroKpis(kpis, catSummary) {
    const sec = $('kpiSection');
    let firstTwo = '';

    if (catSummary) {
      firstTwo = `
        <div class="col-span-2 rounded-2xl p-4 sm:p-5 bg-sky-50/80 dark:bg-sky-950/40 border-2 border-sky-400/80 dark:border-sky-600/80 shadow-sm">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300 truncate">
              Kategorie: ${escapeHtml(catSummary.name)}
            </span>
            <button type="button" data-kpi-reset-cat class="text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:underline shrink-0">
              &times; Alle anzeigen
            </button>
          </div>
          <div class="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
              ${formatEur(catSummary.monthly_total)}<span class="text-sm font-medium text-slate-500 dark:text-slate-400"> / Mt.</span>
            </span>
            <span class="text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300">
              ca. ${formatEur(catSummary.yearly_total)} / Jahr
            </span>
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
            <span><strong>${catSummary.active_count}</strong> aktive Verträge</span>
            ${catSummary.monthly_investments > 0 ? `
              <span class="text-slate-500 dark:text-slate-400">
                Fixkosten: ${formatEur(catSummary.monthly_expenses)}/Mt. &bull;
                <span class="text-emerald-600 dark:text-emerald-400 font-semibold">Investments: ${formatEur(catSummary.monthly_investments)}/Mt.</span>
              </span>
            ` : ''}
            ${catSummary.review_count > 0 ? `<span class="text-amber-600 dark:text-amber-400 font-medium">+ ${catSummary.review_count} zu prüfen</span>` : ''}
          </div>
        </div>
      `;
    } else {
      firstTwo = `
        <button type="button" data-kpi-filter="expense" class="text-left group rounded-2xl p-4 sm:p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-sky-400/70 dark:hover:border-sky-500/60 shadow-sm transition">
          <div class="text-xs font-medium text-slate-500 dark:text-slate-400">Fixkosten / Monat</div>
          <div class="mt-1.5 text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">${formatEur(kpis.total_monthly)}</div>
          <div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            ca. ${formatEur(kpis.total_yearly)} / Jahr
            ${kpis.total_monthly_investments > 0 ? `<span class="block text-slate-400 dark:text-slate-500">Cashflow gesamt: ${formatEur(kpis.total_monthly_cashflow)}/Mt.</span>` : ''}
          </div>
        </button>

        <button type="button" data-kpi-filter="investment" class="text-left group rounded-2xl p-4 sm:p-5 bg-emerald-50/50 dark:bg-emerald-950/25 border border-emerald-200/80 dark:border-emerald-800/60 hover:border-emerald-400 dark:hover:border-emerald-600 shadow-sm transition">
          <div class="text-xs font-medium text-emerald-700 dark:text-emerald-300">Investments / Monat</div>
          <div class="mt-1.5 text-xl sm:text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">${formatEur(kpis.total_monthly_investments)}</div>
          <div class="mt-1 text-[11px] text-emerald-700/70 dark:text-emerald-400/80">
            ca. ${formatEur(kpis.total_yearly_investments)} / Jahr (${kpis.investment_count})
          </div>
        </button>
      `;
    }

    sec.innerHTML = `
      ${firstTwo}

      <button type="button" data-kpi-filter="active" class="text-left group rounded-2xl p-4 sm:p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-sky-400/70 dark:hover:border-sky-500/60 shadow-sm transition">
        <div class="text-xs font-medium text-slate-500 dark:text-slate-400">Aktive Verträge</div>
        <div class="mt-1.5 text-xl sm:text-2xl font-bold tracking-tight text-sky-600 dark:text-sky-400">${kpis.active_count}</div>
        <div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Im Notfall-PDF enthalten</div>
      </button>

      <button type="button" data-kpi-filter="review_needed" class="text-left group rounded-2xl p-4 sm:p-5 border shadow-sm transition ${kpis.review_count > 0 ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700/70 hover:border-amber-400' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-sky-400/70'}">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-slate-600 dark:text-slate-300">Zu prüfen</span>
          ${kpis.review_count > 0 ? '<span class="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse"></span>' : ''}
        </div>
        <div class="mt-1.5 text-xl sm:text-2xl font-bold tracking-tight ${kpis.review_count > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-white'}">${kpis.review_count}</div>
        <div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Klicken zum Prüfen</div>
      </button>

      <button type="button" data-kpi-filter="upcoming_deadline" class="text-left col-span-2 lg:col-span-1 group rounded-2xl p-4 sm:p-5 border shadow-sm transition ${kpis.upcoming_deadlines_count > 0 ? 'bg-rose-50/70 dark:bg-rose-950/30 border-rose-300 dark:border-rose-800/70 hover:border-rose-400' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-sky-400/70'}">
        <div class="text-xs font-medium text-slate-600 dark:text-slate-300">Fristen &lt; 60 Tage</div>
        <div class="mt-1.5 text-xl sm:text-2xl font-bold tracking-tight ${kpis.upcoming_deadlines_count > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}">${kpis.upcoming_deadlines_count}</div>
        <div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Kündigungsfristen</div>
      </button>
    `;

    sec.querySelectorAll('[data-kpi-reset-cat]').forEach((b) => {
      b.addEventListener('click', () => {
        selectedCategory = 'all';
        renderDashboard();
      });
    });

    sec.querySelectorAll('[data-kpi-filter]').forEach((b) => {
      b.addEventListener('click', () => {
        const f = b.dataset.kpiFilter;
        selectedCategory = 'all';
        if (f === 'expense' || f === 'investment') {
          selectedStatus = 'active';
          selectedCostType = f;
        } else {
          selectedStatus = f;
          selectedCostType = 'all';
        }
        renderDashboard();
      });
    });
  }

  function renderCategoryPills() {
    const wrap = $('categoryPills');
    const allCats = ['all', ...CATEGORIES];
    wrap.innerHTML = allCats.map((cat) => {
      const active = selectedCategory === cat;
      const label = cat === 'all' ? 'Alle Kategorien' : cat;
      return `
        <button
          type="button"
          data-cat="${escapeHtml(cat)}"
          class="px-2 py-0.5 md:px-3 md:py-1.5 rounded-full text-[11px] md:text-xs font-medium whitespace-nowrap transition ${active ? 'bg-sky-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'}"
        >${escapeHtml(label)}</button>
      `;
    }).join('');

    wrap.querySelectorAll('[data-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedCategory = btn.dataset.cat;
        selectedCostType = 'all';
        renderDashboard();
      });
    });
  }

  function renderGroupedCards(grouped, summarizeCategory) {
    const list = $('contracts-list');
    if (grouped.size === 0) {
      list.innerHTML = `
        <div class="hv-contract-card rounded-2xl p-12 text-center bg-white dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700">
          <p class="text-slate-500 dark:text-slate-400 text-sm mb-4">Keine Verträge für die aktuelle Auswahl gefunden.</p>
          <div class="flex items-center justify-center gap-3">
            <button type="button" id="btnEmptyReset" class="px-4 py-2 rounded-xl text-sm font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">
              Filter zurücksetzen
            </button>
            <button type="button" id="btnEmptyNew" class="px-4 py-2 rounded-xl text-sm font-semibold bg-sky-600 hover:bg-sky-500 text-white">
              + Neuen Vertrag anlegen
            </button>
          </div>
        </div>
      `;
      $('btnEmptyReset').addEventListener('click', () => {
        selectedCategory = 'all';
        selectedStatus = 'all';
        selectedCostType = 'all';
        searchQuery = '';
        $('searchInput').value = '';
        renderDashboard();
      });
      $('btnEmptyNew').addEventListener('click', () => openContractForm(null));
      return;
    }

    const sectionsHtml = [];
    for (const [catName, items] of grouped.entries()) {
      const catSum = summarizeCategory(catName);
      const cardsHtml = items.map((c) => renderContractCard(c)).join('');

      sectionsHtml.push(`
        <section>
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 class="text-lg font-bold tracking-tight text-slate-900 dark:text-white flex flex-wrap items-center gap-2">
              <span>${escapeHtml(catName)}</span>
              <span class="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-200/90 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                <span>${catSum.active_count}</span>
                <span class="text-slate-400">&middot;</span>
                <span class="text-sky-700 dark:text-sky-300">${formatEur(catSum.monthly_total)}/Mt.</span>
              </span>
              ${catSum.monthly_investments > 0 && catSum.monthly_expenses > 0 ? `
                <span class="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-100/80 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300">
                  davon ${formatEur(catSum.monthly_investments)}/Mt. Investments
                </span>
              ` : ''}
              ${catSum.review_count > 0 ? `
                <span class="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100/80 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300">
                  + ${catSum.review_count} zu prüfen
                </span>
              ` : ''}
            </h2>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
            ${cardsHtml}
          </div>
        </section>
      `);
    }

    list.innerHTML = sectionsHtml.join('');

    // Wire card actions
    list.querySelectorAll('[data-copy-val]').forEach((btn) => {
      btn.addEventListener('click', () => window.hvCopy(btn.dataset.copyVal, btn.dataset.copyLabel));
    });
    list.querySelectorAll('[data-edit-id]').forEach((btn) => {
      btn.addEventListener('click', () => openContractForm(Number(btn.dataset.editId)));
    });
    list.querySelectorAll('[data-doc-id]').forEach((btn) => {
      btn.addEventListener('click', () => openPdfPreview(Number(btn.dataset.docId)));
    });
    list.querySelectorAll('[data-set-cost-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.contractId);
        const newType = btn.dataset.setCostType;
        db.run('UPDATE contracts SET cost_type = ?, updated_at = ? WHERE id = ?', [newType, nowIsoUtc(), id]);
        persistDebounced();
        window.hvToast(newType === 'investment' ? 'Als Investment / Sparplan markiert' : 'Als Fixkosten / Ausgabe markiert', 'success');
        renderDashboard();
      });
    });
    list.querySelectorAll('[data-approve-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.approveId);
        db.run("UPDATE contracts SET status = 'active', updated_at = ? WHERE id = ?", [nowIsoUtc(), id]);
        persistDebounced();
        window.hvToast('Vertrag bestätigt und aktiviert!', 'success');
        renderDashboard();
      });
    });
  }

  function renderContractCard(c) {
    const expired = isContractExpired(c);
    const dUntil = daysUntil(c.next_cancellation_deadline);
    const deadlineSoon = c.status !== 'cancelled' && dUntil !== null && dUntil <= 60;
    const cycleLabel = BILLING_CYCLE_LABELS[c.billing_cycle] || c.billing_cycle;

    let borderClass = 'border-slate-200 dark:border-slate-800';
    if (c.status === 'review_needed') borderClass = 'border-amber-400/80 dark:border-amber-600/80';
    else if (c.cost_type === 'investment') borderClass = 'border-emerald-400/70 dark:border-emerald-700/70';
    else if (deadlineSoon) borderClass = 'border-rose-400/80 dark:border-rose-700/80';

    const emCardClasses = emergencyMode ? 'ring-1 ring-rose-500/30 p-5 sm:p-6' : 'p-5';
    const copySvg = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`;

    return `
      <article id="contract-${c.id}" class="hv-contract-card flex flex-col justify-between rounded-2xl bg-white dark:bg-slate-900 border shadow-sm transition hover:shadow-md ${borderClass} ${emCardClasses} ${expired ? 'opacity-75' : ''}">
        <div>
          <!-- Card Header -->
          <div class="flex items-start justify-between gap-3 mb-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5 mb-1">
                ${c.cost_type === 'investment' ? '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">Investment / Sparplan</span>' : ''}
                ${c.is_variable ? '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-300">variabel</span>' : ''}
                ${c.status === 'review_needed' ? '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300">Zu prüfen</span>' : ''}
                ${c.status === 'cancelled' ? '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-400">Gekündigt</span>' : ''}
                ${expired ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-400">Beendet (${formatDateDe(c.end_date)})</span>` : ''}
                ${deadlineSoon ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-300">${dUntil < 0 ? 'Frist abgelaufen!' : `Frist in ${dUntil} Tagen`}</span>` : ''}
              </div>
              <h3 class="${emergencyMode ? 'text-xl' : 'text-base'} font-bold text-slate-900 dark:text-white leading-snug">
                ${escapeHtml(c.provider_name)}
              </h3>
              <p class="text-sm text-slate-500 dark:text-slate-400 truncate">${escapeHtml(c.title)}</p>
            </div>

            <div class="text-right shrink-0">
              <div class="text-base font-bold ${expired || c.status === 'cancelled' ? 'line-through text-slate-400' : 'text-sky-600 dark:text-sky-400'}">
                ${c.is_variable ? '<span class="text-xs font-medium text-slate-500 dark:text-slate-400 mr-0.5">~ ca.</span>' : ''}${formatEur(c.monthly_equivalent)}<span class="text-xs font-normal text-slate-500">/Mt.</span>
              </div>
              ${c.billing_cycle !== 'monthly' ? `<div class="text-[11px] text-slate-500 dark:text-slate-400">${formatEur(c.cost_amount)} (${escapeHtml(cycleLabel)})</div>` : ''}
            </div>
          </div>

          <!-- Vertrags- & Kundennummer mit One-Click-Copy -->
          <div class="space-y-2 mb-3.5">
            ${c.contract_number ? `
              <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950/80 border border-slate-200/70 dark:border-slate-800">
                <div class="min-w-0">
                  <span class="block text-[10px] uppercase tracking-wider text-slate-400">Vertragsnummer</span>
                  <span class="${emergencyMode ? 'text-base' : 'text-xs sm:text-sm'} font-mono font-semibold text-slate-800 dark:text-slate-100 break-all">${escapeHtml(c.contract_number)}</span>
                </div>
                <button type="button" data-copy-val="${escapeHtml(c.contract_number)}" data-copy-label="Vertragsnummer" title="Vertragsnummer kopieren" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-500 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition shrink-0 no-print">${copySvg}</button>
              </div>
            ` : ''}

            ${c.customer_number ? `
              <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950/80 border border-slate-200/70 dark:border-slate-800">
                <div class="min-w-0">
                  <span class="block text-[10px] uppercase tracking-wider text-slate-400">Kundennummer</span>
                  <span class="${emergencyMode ? 'text-base' : 'text-xs sm:text-sm'} font-mono font-semibold text-slate-800 dark:text-slate-100 break-all">${escapeHtml(c.customer_number)}</span>
                </div>
                <button type="button" data-copy-val="${escapeHtml(c.customer_number)}" data-copy-label="Kundennummer" title="Kundennummer kopieren" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-500 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition shrink-0 no-print">${copySvg}</button>
              </div>
            ` : ''}
          </div>

          <!-- Notfall-Kontakt / Hotline -->
          ${c.emergency_contact ? `
            <div class="mb-3.5 px-3 py-2.5 rounded-xl bg-rose-50/70 dark:bg-rose-950/40 border border-rose-200/80 dark:border-rose-900/70">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <span class="block text-[10px] uppercase tracking-wider font-semibold text-rose-600 dark:text-rose-400">Notfall-Kontakt / Portal</span>
                  <p class="${emergencyMode ? 'text-sm font-bold' : 'text-xs font-medium'} text-rose-900 dark:text-rose-100 break-words mt-0.5">${escapeHtml(c.emergency_contact)}</p>
                </div>
                <button type="button" data-copy-val="${escapeHtml(c.emergency_contact)}" data-copy-label="Notfall-Kontakt" title="Kontakt kopieren" class="p-1 rounded-lg text-rose-400 hover:text-rose-600 dark:hover:text-rose-200 shrink-0 no-print">${copySvg}</button>
              </div>
            </div>
          ` : ''}

          <!-- Notizen -->
          ${c.notes ? `<p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mb-3 whitespace-pre-line">${escapeHtml(c.notes)}</p>` : ''}

          <!-- Kündigungsfrist & Quelle -->
          ${!emergencyMode && (c.next_cancellation_deadline || c.source_email_subject) ? `
            <div class="text-[11px] text-slate-500 dark:text-slate-400 space-y-1 mb-3">
              ${c.next_cancellation_deadline ? `<div>Nächste Kündigungsfrist: <strong class="text-slate-700 dark:text-slate-200">${formatDateDe(c.next_cancellation_deadline)}</strong>${c.notice_period_days ? ` (${c.notice_period_days} Tage)` : ''}</div>` : ''}
              ${c.source_email_subject ? `<div class="truncate" title="${escapeHtml(c.source_email_subject)}">Mail-Import: ${escapeHtml(c.source_email_subject)}</div>` : ''}
            </div>
          ` : ''}
        </div>

        <!-- Card Footer -->
        <div class="pt-3 mt-1 border-t border-slate-100 dark:border-slate-800 space-y-2 no-print">
          ${c.status === 'review_needed' ? `
            <div class="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <button type="button" data-contract-id="${c.id}" data-set-cost-type="expense" class="px-2 py-1.5 rounded-lg text-[11px] font-semibold transition ${(c.cost_type || 'expense') === 'expense' ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}">Ausgabe</button>
              <button type="button" data-contract-id="${c.id}" data-set-cost-type="investment" class="px-2 py-1.5 rounded-lg text-[11px] font-semibold transition ${c.cost_type === 'investment' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400'}">Investment</button>
            </div>
            <button type="button" data-approve-id="${c.id}" class="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
              Review bestätigen &amp; aktivieren
            </button>
          ` : ''}

          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-1.5">
              ${(c.documents || []).map((doc) => `
                <button type="button" data-doc-id="${doc.id}" title="PDF ansehen: ${escapeHtml(doc.filename)}" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-sky-50 hover:bg-sky-100 dark:bg-sky-950/60 dark:hover:bg-sky-900/60 text-sky-700 dark:text-sky-300 border border-sky-200/70 dark:border-sky-800/60 transition">
                  <svg class="w-3.5 h-3.5 text-rose-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
                  <span class="max-w-[140px] truncate">${escapeHtml(doc.filename)}</span>
                </button>
              `).join('')}
            </div>

            <button type="button" data-edit-id="${c.id}" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition">
              Bearbeiten
            </button>
          </div>
        </div>
      </article>
    `;
  }

  /* --- Contract Form View (1:1 QNAP contract_form.html) --- */
  function updateMonthlyPreview() {
    const val = parseGermanFloat($('fieldAmount').value);
    const cyc = $('fieldCycle').value;
    const eq = calculateMonthlyEquivalent(val, cyc);
    $('monthlyPreview').textContent = `${formatGermanDecimal(eq)} € / Monat`;
  }

  function openContractForm(contractId) {
    $('contractForm').reset();
    pendingNewPdfs = [];
    activeContactSuggestion = null;
    $('selectedPdfBadges').innerHTML = '';
    $('selectedPdfBadges').classList.add('hidden');
    $('pdfSuggestionsBox').classList.add('hidden');
    $('pdfSuggestionsChips').innerHTML = '';
    $('contactSuggestionBanner').classList.add('hidden');

    if (contractId) {
      const c = queryOne(db, 'SELECT * FROM contracts WHERE id = ?', [contractId]);
      if (!c) return;
      lastEditedContractId = c.id;
      $('fieldId').value = c.id;
      $('formHeading').textContent = `${c.provider_name} – ${c.title}`;
      $('btnFormSubmit').textContent = 'Änderungen speichern';
      $('btnFormApprove').classList.toggle('hidden', c.status !== 'review_needed');
      $('formDocsSection').classList.remove('hidden');

      $('fieldCategory').value = CATEGORIES.includes(c.category) ? c.category : CATEGORIES[CATEGORIES.length - 1];
      $('fieldCostType').value = c.cost_type || 'expense';
      $('fieldStatus').value = c.status || 'active';
      $('fieldProvider').value = c.provider_name || '';
      $('fieldTitle').value = c.title || '';
      $('fieldContractNumber').value = c.contract_number || '';
      $('fieldCustomerNumber').value = c.customer_number || '';
      $('fieldAmount').value = formatGermanDecimal(c.cost_amount);
      $('fieldCycle').value = c.billing_cycle || 'monthly';
      $('fieldVariable').checked = !!c.is_variable;
      $('fieldStartDate').value = c.start_date ? String(c.start_date).slice(0, 10) : '';
      $('fieldEndDate').value = c.end_date ? String(c.end_date).slice(0, 10) : '';
      $('fieldNoticeDays').value = c.notice_period_days !== null && c.notice_period_days !== undefined ? c.notice_period_days : '';
      $('fieldDeadline').value = c.next_cancellation_deadline ? String(c.next_cancellation_deadline).slice(0, 10) : '';
      $('fieldEmergencyContact').value = c.emergency_contact || '';
      $('fieldNotes').value = c.notes || '';

      renderFormDocsList(c.id);
    } else {
      lastEditedContractId = null;
      $('fieldId').value = '';
      $('formHeading').textContent = 'Neuen Vertrag anlegen';
      $('btnFormSubmit').textContent = 'Vertrag anlegen';
      $('btnFormApprove').classList.add('hidden');
      $('formDocsSection').classList.add('hidden');
      $('fieldCategory').value = CATEGORIES[0];
      $('fieldCostType').value = 'expense';
      $('fieldStatus').value = 'active';
      $('fieldCycle').value = 'monthly';
      $('fieldAmount').value = '0,00';
    }

    updateMonthlyPreview();
    showView('form');
    window.scrollTo({ top: 0, behavior: 'instant' });
    triggerContactLookup();
  }

  function returnToDashboard(highlightId = null) {
    showView('dashboard');
    renderDashboard();
    if (highlightId) {
      setTimeout(() => {
        const el = document.getElementById(`contract-${highlightId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('hv-contract-highlight');
          setTimeout(() => el.classList.remove('hv-contract-highlight'), 2200);
        }
      }, 80);
    }
  }

  function renderFormDocsList(contractId) {
    const docs = queryAll(db, 'SELECT * FROM documents WHERE contract_id = ? ORDER BY uploaded_at DESC', [contractId]);
    $('formDocsTitle').textContent = `Angehängte Dokumente (${docs.length})`;
    const ul = $('existingDocsList');
    if (!docs.length) {
      ul.innerHTML = `<li class="py-3 text-xs text-slate-400">Noch keine Dokumente angehängt.</li>`;
      return;
    }
    ul.innerHTML = docs.map((doc) => `
      <li class="py-3 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <button type="button" data-form-doc-preview="${doc.id}" class="text-sm font-medium text-sky-600 dark:text-sky-400 hover:underline truncate block text-left">
            ${escapeHtml(doc.filename)}
          </button>
          <span class="text-xs text-slate-400">Hochgeladen: ${escapeHtml(String(doc.uploaded_at || '').slice(0, 16))}</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button type="button" data-form-doc-preview="${doc.id}" class="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">Ansehen</button>
          <button type="button" data-form-doc-dl="${doc.id}" class="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">Download</button>
          <button type="button" data-form-doc-del="${doc.id}" class="px-3 py-1.5 rounded-lg text-xs font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/60">Löschen</button>
        </div>
      </li>
    `).join('');

    ul.querySelectorAll('[data-form-doc-preview]').forEach((b) => {
      b.addEventListener('click', () => openPdfPreview(Number(b.dataset.formDocPreview)));
    });
    ul.querySelectorAll('[data-form-doc-dl]').forEach((b) => {
      b.addEventListener('click', async () => {
        const doc = queryOne(db, 'SELECT * FROM documents WHERE id = ?', [Number(b.dataset.formDocDl)]);
        if (!doc) return;
        const bytes = await Storage.readUploadFile(doc.file_path);
        downloadBytes(bytes, doc.filename, 'application/pdf');
      });
    });
    ul.querySelectorAll('[data-form-doc-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        const docId = Number(b.dataset.formDocDel);
        const doc = queryOne(db, 'SELECT * FROM documents WHERE id = ?', [docId]);
        if (!doc || !confirm(`Dokument „${doc.filename}“ wirklich löschen?`)) return;
        await Storage.deleteUploadFile(doc.file_path);
        db.run('DELETE FROM documents WHERE id = ?', [docId]);
        persistDebounced();
        renderFormDocsList(contractId);
        window.hvToast('Dokument gelöscht.', 'info');
      });
    });
  }

  async function triggerContactLookup() {
    const prov = $('fieldProvider').value.trim();
    const curContact = $('fieldEmergencyContact').value.trim();
    const banner = $('contactSuggestionBanner');
    if (prov.length < 2 || curContact.length > 0) {
      activeContactSuggestion = null;
      banner.classList.add('hidden');
      return;
    }
    const found = await ContactsSvc.lookup(prov, $('fieldTitle').value.trim(), getAllContractsForCurrentProfile());
    if (found && found.contact) {
      activeContactSuggestion = found.contact;
      $('contactSuggestionSource').textContent = found.source ? ` (${found.source})` : '';
      $('contactSuggestionText').textContent = found.contact;
      banner.classList.remove('hidden');
    } else {
      activeContactSuggestion = null;
      banner.classList.add('hidden');
    }
  }

  async function handleFormPdfFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');
    if (!files.length) return;

    const allSuggestions = { providers: [], ibans: [], amounts: [], dates: [], contractNumbers: [] };
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let extractedText = '';
      try {
        const res = await PdfSvc.extractTextAndSuggestions(bytes);
        extractedText = res.text || '';
        for (const x of (res.suggestions.providers || [])) if (!allSuggestions.providers.includes(x)) allSuggestions.providers.push(x);
        for (const x of res.suggestions.ibans) if (!allSuggestions.ibans.includes(x)) allSuggestions.ibans.push(x);
        for (const x of res.suggestions.amounts) if (!allSuggestions.amounts.includes(x)) allSuggestions.amounts.push(x);
        for (const x of res.suggestions.dates) if (!allSuggestions.dates.some((d) => d.iso === x.iso)) allSuggestions.dates.push(x);
        for (const x of res.suggestions.contractNumbers) if (!allSuggestions.contractNumbers.includes(x)) allSuggestions.contractNumbers.push(x);
      } catch { /* ignore */ }
      pendingNewPdfs.push({ filename: file.name, bytes, extractedText });
    }

    const badges = $('selectedPdfBadges');
    badges.classList.remove('hidden');
    badges.innerHTML = pendingNewPdfs.map((p) => `<span class="px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-100 dark:bg-sky-900/60 text-sky-800 dark:text-sky-200">${escapeHtml(p.filename)}</span>`).join('');

    renderPdfSuggestionChips(allSuggestions);
  }

  function renderPdfSuggestionChips(sugg) {
    const chips = [];
    for (const prov of (sugg.providers || [])) {
      chips.push({
        label: `Anbieter: ${prov}`,
        action: () => {
          $('fieldProvider').value = prov;
          triggerContactLookup();
        }
      });
    }
    for (const num of sugg.contractNumbers) chips.push({ label: `Nr: ${num}`, action: () => { $('fieldContractNumber').value = num; } });
    for (const amt of sugg.amounts) chips.push({ label: `Betrag: ${amt} €`, action: () => { $('fieldAmount').value = amt; updateMonthlyPreview(); } });
    for (const d of sugg.dates) chips.push({ label: `Datum: ${d.display}`, action: () => { if (!$('fieldStartDate').value) $('fieldStartDate').value = d.iso; else $('fieldEndDate').value = d.iso; } });
    for (const iban of sugg.ibans) chips.push({ label: `IBAN: ${iban}`, action: () => { const cur = $('fieldNotes').value.trim(); if (!cur.includes(iban)) $('fieldNotes').value = cur ? `${cur}\nIBAN: ${iban}` : `IBAN: ${iban}`; } });

    const box = $('pdfSuggestionsBox');
    const wrap = $('pdfSuggestionsChips');
    if (!chips.length) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    wrap.innerHTML = '';
    for (const item of chips) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'px-2.5 py-1 rounded-full text-xs font-medium bg-white dark:bg-slate-900 border border-sky-300 dark:border-sky-700 text-slate-700 dark:text-slate-200 hover:bg-sky-100 dark:hover:bg-sky-900/60 transition';
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        item.action();
        window.hvToast(`Übernommen: ${item.label}`, 'success');
      });
      wrap.appendChild(btn);
    }
  }

  function generateRelUploadPath(filename) {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const rand = Math.random().toString(16).slice(2, 10);
    const safeName = filename.replace(/[^a-zA-Z0-9._\-äöüÄÖÜß]/g, '_');
    return `${yyyy}/${mm}/${rand}_${safeName}`;
  }

  async function handleSaveContract(e) {
    e.preventDefault();
    const idRaw = $('fieldId').value;
    const provider = $('fieldProvider').value.trim();
    const title = $('fieldTitle').value.trim();
    if (!provider || !title) {
      window.hvToast('Bitte Anbieter und Vertragstitel ausfüllen.', 'error');
      return;
    }

    const category = $('fieldCategory').value;
    const costAmount = parseGermanFloat($('fieldAmount').value);
    const billingCycle = $('fieldCycle').value;
    const monthlyEq = calculateMonthlyEquivalent(costAmount, billingCycle);
    const costType = $('fieldCostType').value;
    const status = $('fieldStatus').value;
    const isVariable = $('fieldVariable').checked ? 1 : 0;
    const contractNumber = $('fieldContractNumber').value.trim() || null;
    const customerNumber = $('fieldCustomerNumber').value.trim() || null;
    const startDate = $('fieldStartDate').value || null;
    const endDate = $('fieldEndDate').value || null;
    const noticeDays = $('fieldNoticeDays').value !== '' ? parseInt($('fieldNoticeDays').value, 10) : null;
    const explicitDeadline = $('fieldDeadline').value || null;
    const nextDeadline = calculateNextCancellationDeadline(endDate, noticeDays, explicitDeadline);
    const emergencyContact = $('fieldEmergencyContact').value.trim() || null;
    const notes = $('fieldNotes').value.trim() || null;
    const now = nowIsoUtc();

    let contractId;
    if (idRaw) {
      contractId = Number(idRaw);
      db.run(
        `UPDATE contracts SET
          category=?, provider_name=?, title=?, contract_number=?, customer_number=?,
          cost_amount=?, billing_cycle=?, monthly_equivalent=?, cost_type=?, is_variable=?,
          start_date=?, end_date=?, notice_period_days=?, next_cancellation_deadline=?,
          emergency_contact=?, notes=?, status=?, updated_at=?
        WHERE id=?`,
        [
          category, provider, title, contractNumber, customerNumber,
          costAmount, billingCycle, monthlyEq, costType, isVariable,
          startDate, endDate, noticeDays, nextDeadline,
          emergencyContact, notes, status, now, contractId
        ]
      );
    } else {
      db.run(
        `INSERT INTO contracts (
          category, provider_name, title, contract_number, customer_number,
          cost_amount, billing_cycle, monthly_equivalent, cost_type, is_variable, is_demo,
          start_date, end_date, notice_period_days, next_cancellation_deadline,
          emergency_contact, notes, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          category, provider, title, contractNumber, customerNumber,
          costAmount, billingCycle, monthlyEq, costType, isVariable, demoMode ? 1 : 0,
          startDate, endDate, noticeDays, nextDeadline,
          emergencyContact, notes, status, now, now
        ]
      );
      const idRes = db.exec('SELECT last_insert_rowid();');
      contractId = Number(idRes[0].values[0][0]);
    }

    for (const pdf of pendingNewPdfs) {
      const relPath = generateRelUploadPath(pdf.filename);
      await Storage.writeUploadFile(relPath, pdf.bytes);
      db.run(
        `INSERT INTO documents (contract_id, filename, file_path, mime_type, extracted_text, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contractId, pdf.filename, relPath, 'application/pdf', pdf.extractedText || null, now]
      );
    }
    pendingNewPdfs = [];

    persistDebounced();
    window.hvToast(idRaw ? 'Änderungen gespeichert!' : 'Vertrag angelegt!', 'success');
    returnToDashboard(contractId);
  }

  /* --- PDF Preview Modal --- */
  function downloadBytes(bytes, filename, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function openPdfPreview(docId) {
    const doc = queryOne(db, 'SELECT * FROM documents WHERE id = ?', [docId]);
    if (!doc) return;

    currentPreviewDoc = null;
    $('pdfPreviewTitle').textContent = doc.filename || 'Dokument.pdf';
    const pageBadge = $('pdfPageInfo');
    pageBadge.classList.add('hidden');
    const container = $('pdfPagesContainer');
    container.scrollTop = 0;

    // Modal zuerst sichtbar machen und sofort Ladehinweis anzeigen
    $('pdfModal').classList.remove('hidden');
    PdfSvc.showLoadingState(container, 'PDF wird geladen…');

    try {
      const bytes = await Storage.readUploadFile(doc.file_path);
      if (!bytes || bytes.length === 0) {
        throw new Error('Die PDF-Datei im lokalen Speicher ist leer oder fehlt.');
      }
      currentPreviewDoc = { filename: doc.filename, bytes };

      await PdfSvc.renderAllPagesIntoContainer(bytes, container, (cur, total) => {
        if (total > 1) {
          pageBadge.textContent = `Seite ${cur} / ${total}`;
          pageBadge.classList.remove('hidden');
        } else {
          pageBadge.classList.add('hidden');
        }
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || 'Unbekannter Fehler');
      const hint = /NotFoundError|not found|fehlt/i.test(msg)
        ? `Datei nicht im lokalen uploads/-Ordner gefunden (${doc.file_path}). Falls du ein Backup genutzt hast, prüfe den Ordnerzugriff oder stelle das ZIP neu wieder her.`
        : msg;
      PdfSvc.showErrorState(container, 'PDF konnte nicht angezeigt werden', hint);
      window.hvToast(`PDF-Fehler: ${msg}`, 'error');
    }
  }

  function closePdfModal() {
    $('pdfModal').classList.add('hidden');
    const container = $('pdfPagesContainer');
    if (container) container.innerHTML = '';
    PdfSvc.destroyCurrentPdf();
  }

  /* --- Kontoauszug CSV Modal --- */
  function openStatementModal() {
    $('csvFileInput').value = '';
    $('csvSummary').classList.add('hidden');
    $('csvTableWrap').classList.add('hidden');
    $('csvFooter').classList.add('hidden');
    csvCandidates = [];
    $('statementModal').classList.remove('hidden');
  }

  async function handleCsvFile(file) {
    if (!file) return;
    const summaryEl = $('csvSummary');
    summaryEl.classList.remove('hidden');
    summaryEl.textContent = 'Kontoauszug (CSV/PDF) wird lokal analysiert...';
    try {
      const res = await CsvSvc.parseStatementFile(file);
      csvCandidates = res.candidates;
      const fmtMap = { bank: 'Bank-Kontoauszug', amex: 'American Express', paypal: 'PayPal' };
      const typeLabel = res.sourceType === 'pdf'
        ? `PDF (${res.numPages || 1} S.)`
        : 'CSV';
      summaryEl.innerHTML = `Typ: <strong>${typeLabel}</strong> &bull; Format: <strong>${fmtMap[res.format] || res.format}</strong> &bull; ${res.expenseRows} Ausgaben &bull; <strong>${csvCandidates.length}</strong> Posten erkannt.`;

      if (!csvCandidates.length) {
        $('csvTableWrap').classList.add('hidden');
        $('csvFooter').classList.add('hidden');
        return;
      }

      $('csvCandidatesBody').innerHTML = csvCandidates.map((c, i) => `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <td class="p-2.5"><input type="checkbox" class="csv-row-check w-4 h-4 rounded" data-idx="${i}" ${c.selected ? 'checked' : ''} /></td>
          <td class="p-2.5">
            <div class="font-semibold text-slate-900 dark:text-white">${escapeHtml(c.provider_name)}</div>
            <div class="text-[11px] text-slate-500 truncate max-w-[240px]">${escapeHtml(c.title)}</div>
          </td>
          <td class="p-2.5 text-slate-600 dark:text-slate-300">${escapeHtml(c.category)}</td>
          <td class="p-2.5 text-right font-semibold text-sky-600 dark:text-sky-400">${formatEur(c.cost_amount)}</td>
          <td class="p-2.5 text-slate-600 dark:text-slate-300">${escapeHtml(BILLING_CYCLE_LABELS[c.billing_cycle] || c.billing_cycle)} (${c.occurrences}x)</td>
        </tr>
      `).join('');

      $('csvTableWrap').classList.remove('hidden');
      $('csvFooter').classList.remove('hidden');
    } catch (err) {
      summaryEl.textContent = `Fehler: ${err.message}`;
      $('csvTableWrap').classList.add('hidden');
      $('csvFooter').classList.add('hidden');
    }
  }

  /* --- Settings & Backup View --- */
  function openSettingsView() {
    const info = Storage.getInfo();
    $('settingsStorageInfo').innerHTML = info.mode === 'fsa'
      ? `Modus: <strong>File System Access API</strong> &bull; Ordner: <code class="font-mono text-slate-700 dark:text-slate-200">${escapeHtml(info.folderName || '–')}</code>`
      : `Modus: <strong>Browser-Speicher (OPFS)</strong> (Safari/Firefox-Fallback)`;
    $('btnSettingsChangeFolder').classList.toggle('hidden', !info.supportsFSA);

    if (db) {
      const cCount = queryOne(db, 'SELECT COUNT(*) AS n FROM contracts WHERE COALESCE(is_demo,0)=0')?.n || 0;
      const dCount = queryOne(db, 'SELECT COUNT(*) AS n FROM documents')?.n || 0;
      $('settingsDbStats').textContent = `Verträge (Haupt-Account): ${cCount} · Dokumente: ${dCount}`;
    }

    pendingSettingsZipFile = null;
    $('settingsSelectedZipName').textContent = 'HomeVault Backup-Datei (.zip) auswählen...';
    $('confirmRestoreCheck').checked = false;
    $('btnSettingsRestoreZip').disabled = true;

    showView('settings');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function updateRestoreBtnState() {
    $('btnSettingsRestoreZip').disabled = !(pendingSettingsZipFile && $('confirmRestoreCheck').checked);
  }

  async function executeZipRestore(file) {
    try {
      await initSqlEngine();
      showView('loading');
      $('loadingMessage').textContent = 'Prüfe und entpacke HomeVault-Backup (.zip)...';
      const result = await Backup.importBackupZip(file, SQL, Storage, (msg) => {
        $('loadingMessage').textContent = msg;
      });
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
      db = result.db;

      const info = Storage.getInfo();
      updateSyncPill({ state: 'saved', mode: info.mode, folderName: info.folderName });
      demoMode = false;
      $('toggleDemoMode').checked = false;
      showView('dashboard');
      renderDashboard();
      window.hvToast(`Backup wiederhergestellt (${result.importedDocsCount} Dokumente).`, 'success');
    } catch (err) {
      window.hvToast(`Restore fehlgeschlagen: ${err.message}`, 'error');
      if (db) showView('dashboard');
      else showView('setup');
    }
  }

  async function handleExportZip() {
    if (!db) return;
    try {
      const { filename } = await Backup.exportBackupZip(db, Storage);
      window.hvToast(`Komplett-Backup gespeichert: ${filename}`, 'success');
    } catch (err) {
      window.hvToast(`Backup fehlgeschlagen: ${err.message}`, 'error');
    }
  }

  /* --- Event Bindings --- */
  function populateCategorySelect() {
    $('fieldCategory').innerHTML = CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }

  function bindEvents() {
    // Brand link -> Dashboard
    $('brandLink').addEventListener('click', (e) => {
      e.preventDefault();
      if (db) returnToDashboard();
    });

    // Mobile drawer
    $('btnMobileMenuToggle').addEventListener('click', () => {
      $('mobileMenuDrawer').classList.toggle('hidden');
    });

    // Header actions
    $('btnOpenStatementUpload').addEventListener('click', openStatementModal);
    $('btnMobileStatement').addEventListener('click', () => {
      $('mobileMenuDrawer').classList.add('hidden');
      openStatementModal();
    });

    const triggerEmergencyPrint = () => {
      $('mobileMenuDrawer').classList.add('hidden');
      emergencyMode = true;
      localStorage.setItem('hv_emergency_mode', 'true');
      showView('dashboard');
      renderDashboard();
      setTimeout(() => window.print(), 200);
    };
    $('btnEmergencyPrint').addEventListener('click', triggerEmergencyPrint);
    $('btnMobileEmergencyPrint').addEventListener('click', triggerEmergencyPrint);
    $('btnEmergencyBannerPrint').addEventListener('click', () => window.print());

    $('btnNewContractDesktop').addEventListener('click', () => openContractForm(null));
    $('btnNewContractMobile').addEventListener('click', () => openContractForm(null));
    $('btnOpenSettingsDesktop').addEventListener('click', openSettingsView);
    $('btnMobileSettings').addEventListener('click', () => {
      $('mobileMenuDrawer').classList.add('hidden');
      openSettingsView();
    });

    // Setup Screen
    $('btnSetupNewFolder').addEventListener('click', async () => {
      try {
        await Storage.pickDirectory();
        showView('loading');
        $('loadingMessage').textContent = 'Öffne Datenbank im gewählten Ordner...';
        await openOrCreateDatabaseFromStorage();
        window.hvToast('Speicherordner verbunden.', 'success');
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        window.hvToast(err.message || 'Ordnerauswahl abgebrochen.', 'error');
      }
    });

    $('btnSetupRestoreZip').addEventListener('click', async () => {
      try {
        await Storage.pickDirectory();
        pendingZipAction = 'setup_restore';
        $('hiddenZipInput').click();
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        window.hvToast(err.message || 'Ordnerauswahl abgebrochen.', 'error');
      }
    });

    // Permission Reactivation
    $('btnReactivateFolder').addEventListener('click', async () => {
      try {
        await Storage.reactivatePermission();
        showView('loading');
        $('loadingMessage').textContent = 'Lade homevault.db...';
        await openOrCreateDatabaseFromStorage();
      } catch (err) {
        window.hvToast(err.message || 'Ordnerzugriff abgelehnt.', 'error');
      }
    });

    $('btnChangeFolderFromPerm').addEventListener('click', async () => {
      await Storage.resetDirectory();
      showView('setup');
    });

    // Hidden ZIP input
    $('hiddenZipInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const act = pendingZipAction;
      pendingZipAction = null;

      if (act === 'settings_pick') {
        pendingSettingsZipFile = file;
        $('settingsSelectedZipName').textContent = file.name;
        updateRestoreBtnState();
        return;
      }
      if (act === 'opfs_restore') {
        if (!confirm('Alle aktuellen Daten im Browser-Speicher werden durch das Backup ersetzt. Fortfahren?')) return;
      }
      await executeZipRestore(file);
    });

    // Dashboard Filters
    $('searchInput').addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      renderDashboard();
    });
    $('filterStatus').addEventListener('change', (e) => {
      selectedStatus = e.target.value;
      selectedCostType = 'all';
      renderDashboard();
    });
    $('btnEmergencyToggle').addEventListener('click', () => {
      emergencyMode = !emergencyMode;
      localStorage.setItem('hv_emergency_mode', emergencyMode ? 'true' : 'false');
      renderDashboard();
    });

    // Contract Form events
    $('btnFormBack').addEventListener('click', () => returnToDashboard(lastEditedContractId));
    $('btnFormCancel').addEventListener('click', () => returnToDashboard(lastEditedContractId));
    $('contractForm').addEventListener('submit', handleSaveContract);
    $('fieldAmount').addEventListener('input', updateMonthlyPreview);
    $('fieldAmount').addEventListener('blur', () => {
      $('fieldAmount').value = formatGermanDecimal(parseGermanFloat($('fieldAmount').value));
      updateMonthlyPreview();
    });
    $('fieldCycle').addEventListener('change', updateMonthlyPreview);
    $('fieldProvider').addEventListener('input', () => {
      clearTimeout(window.__hvContactLookupTimer);
      window.__hvContactLookupTimer = setTimeout(triggerContactLookup, 300);
    });
    $('fieldEmergencyContact').addEventListener('input', triggerContactLookup);
    $('btnApplyContactSuggestion').addEventListener('click', () => {
      if (activeContactSuggestion) {
        $('fieldEmergencyContact').value = activeContactSuggestion;
        activeContactSuggestion = null;
        $('contactSuggestionBanner').classList.add('hidden');
      }
    });
    $('btnFormApprove').addEventListener('click', () => {
      const id = Number($('fieldId').value);
      if (!id) return;
      db.run("UPDATE contracts SET status = 'active', updated_at = ? WHERE id = ?", [nowIsoUtc(), id]);
      persistDebounced();
      window.hvToast('Vertrag bestätigt und aktiviert!', 'success');
      returnToDashboard(id);
    });
    $('btnDeleteContract').addEventListener('click', async () => {
      const id = Number($('fieldId').value);
      if (!id || !confirm('Diesen Vertrag inkl. aller angehängten PDFs dauerhaft löschen?')) return;
      const docs = queryAll(db, 'SELECT * FROM documents WHERE contract_id = ?', [id]);
      for (const d of docs) await Storage.deleteUploadFile(d.file_path);
      db.run('DELETE FROM documents WHERE contract_id = ?', [id]);
      db.run('DELETE FROM contracts WHERE id = ?', [id]);
      persistDebounced();
      window.hvToast('Vertrag gelöscht.', 'info');
      returnToDashboard();
    });

    // PDF DropZone in Contract Form
    const pdfZone = $('pdfDropZone');
    pdfZone.addEventListener('click', () => $('contractPdfInput').click());
    pdfZone.addEventListener('dragover', (e) => { e.preventDefault(); pdfZone.classList.add('border-sky-500'); });
    pdfZone.addEventListener('dragleave', () => pdfZone.classList.remove('border-sky-500'));
    pdfZone.addEventListener('drop', (e) => {
      e.preventDefault();
      pdfZone.classList.remove('border-sky-500');
      handleFormPdfFiles(e.dataTransfer.files);
    });
    $('contractPdfInput').addEventListener('change', (e) => handleFormPdfFiles(e.target.files));

    // Statement CSV Modal
    $('btnCloseStatementModal').addEventListener('click', () => $('statementModal').classList.add('hidden'));
    const csvZone = $('csvDropZone');
    csvZone.addEventListener('click', () => $('csvFileInput').click());
    csvZone.addEventListener('dragover', (e) => { e.preventDefault(); csvZone.classList.add('border-emerald-500'); });
    csvZone.addEventListener('dragleave', () => csvZone.classList.remove('border-emerald-500'));
    csvZone.addEventListener('drop', (e) => {
      e.preventDefault();
      csvZone.classList.remove('border-emerald-500');
      if (e.dataTransfer.files.length) handleCsvFile(e.dataTransfer.files[0]);
    });
    $('csvFileInput').addEventListener('change', (e) => {
      if (e.target.files.length) handleCsvFile(e.target.files[0]);
    });
    $('csvSelectAll').addEventListener('change', (e) => {
      document.querySelectorAll('.csv-row-check').forEach((cb) => { cb.checked = e.target.checked; });
    });
    $('btnCsvImportSelected').addEventListener('click', async () => {
      const checks = Array.from(document.querySelectorAll('.csv-row-check')).filter((cb) => cb.checked);
      if (!checks.length) return;
      const existing = getAllContractsForCurrentProfile();
      const now = nowIsoUtc();
      let imported = 0;
      for (const cb of checks) {
        const c = csvCandidates[Number(cb.dataset.idx)];
        if (!c) continue;
        const monthlyEq = calculateMonthlyEquivalent(c.cost_amount, c.billing_cycle);
        const lookup = await ContactsSvc.lookup(c.provider_name, c.title, existing);
        db.run(
          `INSERT INTO contracts (
            category, provider_name, title, contract_number, cost_amount, billing_cycle, monthly_equivalent,
            cost_type, is_variable, is_demo, emergency_contact, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'review_needed', ?, ?)`,
          [
            c.category, c.provider_name, c.title, c.contract_number || null, c.cost_amount, c.billing_cycle, monthlyEq,
            c.cost_type || detectInvestmentCostType(c.provider_name, c.title, ''),
            c.is_variable ? 1 : 0, demoMode ? 1 : 0,
            lookup ? lookup.contact : null, now, now
          ]
        );
        imported += 1;
      }
      persistDebounced();
      $('statementModal').classList.add('hidden');
      window.hvToast(`${imported} Verträge aus CSV importiert (Zu prüfen).`, 'success');
      renderDashboard();
    });

    // PDF Modal controls (Schließen per ×, Hintergrund-Klick & ESC; Download ohne neuen Tab)
    $('btnClosePdfModal').addEventListener('click', closePdfModal);
    $('pdfModal').addEventListener('click', (e) => {
      if (e.target === $('pdfModal')) closePdfModal();
    });
    $('btnPdfDownload').addEventListener('click', () => {
      if (currentPreviewDoc) downloadBytes(currentPreviewDoc.bytes, currentPreviewDoc.filename, 'application/pdf');
    });

    // Safari Install Modal
    $('btnCloseSafariModal').addEventListener('click', () => $('safariInstallModal').classList.add('hidden'));
    $('btnSafariModalOk').addEventListener('click', () => $('safariInstallModal').classList.add('hidden'));

    // Settings View
    $('btnSettingsBack').addEventListener('click', () => returnToDashboard());
    $('btnSettingsExportZip').addEventListener('click', handleExportZip);
    $('btnSettingsPickZip').addEventListener('click', () => {
      pendingZipAction = 'settings_pick';
      $('hiddenZipInput').click();
    });
    $('confirmRestoreCheck').addEventListener('change', updateRestoreBtnState);
    $('btnSettingsRestoreZip').addEventListener('click', async () => {
      if (!pendingSettingsZipFile || !$('confirmRestoreCheck').checked) return;
      if (!confirm('Achtung: Alle aktuellen Verträge und PDF-Dokumente werden durch das Backup ersetzt. Jetzt wiederherstellen?')) return;
      await executeZipRestore(pendingSettingsZipFile);
    });
    $('btnSettingsChangeFolder').addEventListener('click', async () => {
      try {
        await Storage.flushSave(() => db.export());
        await Storage.pickDirectory();
        showView('loading');
        $('loadingMessage').textContent = 'Wechsle Speicherordner...';
        await openOrCreateDatabaseFromStorage();
        window.hvToast('Speicherordner gewechselt.', 'success');
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        window.hvToast(err.message || 'Ordnerwechsel fehlgeschlagen.', 'error');
      }
    });
    $('toggleDemoMode').addEventListener('change', (e) => {
      demoMode = !!e.target.checked;
      window.hvToast(demoMode ? 'Demo-Ansicht aktiviert' : 'Haupt-Account aktiviert', 'info');
    });

    $('btnSettingsResetAllData').addEventListener('click', async () => {
      const confirmed = confirm(
        'Achtung: Alle lokalen Daten (homevault.db, alle hochgeladenen PDFs in uploads/ sowie die gespeicherte Ordner-Verknüpfung) werden unwiderruflich gelöscht.\n\nHast du vorher ein ZIP-Backup erstellt? Wirklich alle lokalen Daten zurücksetzen?'
      );
      if (!confirmed) return;

      isResetting = true;
      try {
        // Laufende sql.js-Instanz im Arbeitsspeicher sofort schließen & leeren
        if (db) {
          try { db.close(); } catch { /* ignore */ }
          db = null;
        }
        await Storage.wipeAllLocalData();
        localStorage.removeItem('hv_emergency_mode');
        window.location.reload();
      } catch (err) {
        isResetting = false;
        window.hvToast(`Zurücksetzen fehlgeschlagen: ${err.message}`, 'error');
      }
    });

    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closePdfModal();
        $('statementModal').classList.add('hidden');
        $('safariInstallModal').classList.add('hidden');
        $('mobileMenuDrawer').classList.add('hidden');
      }
    });

    // Sticky offsets ResizeObserver (1:1 QNAP app.js)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(hvSyncStickyOffsets);
      const header = $('hv-app-header');
      const filter = $('hv-sticky-filter');
      if (header) ro.observe(header);
      if (filter) ro.observe(filter);
    }
    window.addEventListener('resize', hvSyncStickyOffsets, { passive: true });
    window.addEventListener('beforeunload', () => {
      if (db && !isResetting) Storage.flushSave(() => db.export());
    });
  }

  /* --- Bootstrap --- */
  async function boot() {
    registerServiceWorker();
    populateCategorySelect();
    initPwaInstall();
    Storage.onStatusChange(updateSyncPill);
    bindEvents();

    try {
      await initSqlEngine();
      const state = await Storage.checkStoredState();
      if (state.status === 'needs_setup') {
        showView('setup');
      } else if (state.status === 'needs_permission') {
        $('permFolderName').textContent = state.folderName || 'HomeVault';
        showView('permission');
      } else {
        await openOrCreateDatabaseFromStorage();
      }
    } catch (err) {
      $('loadingMessage').innerHTML = `<span class="text-rose-500 font-semibold">Startfehler: ${escapeHtml(err.message)}</span>`;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
