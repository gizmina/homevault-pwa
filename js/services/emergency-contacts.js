/* HomeVault PWA – Offline Emergency Contact Lookup */
window.HVEmergencyContacts = (() => {
  'use strict';

  let catalog = null;

  async function loadCatalog() {
    if (catalog) return catalog;
    try {
      const resp = await fetch('./assets/providers_contacts.json');
      if (resp.ok) {
        catalog = await resp.json();
      } else {
        catalog = [];
      }
    } catch {
      catalog = [];
    }
    return catalog;
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function matchesKeyword(haystack, keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return false;
    if (kw.length <= 4) {
      const re = new RegExp(`(^|[^a-z0-9äöüß])${escapeRegex(kw)}($|[^a-z0-9äöüß])`, 'i');
      return re.test(haystack);
    }
    return haystack.includes(kw);
  }

  async function lookup(providerName, title, existingContracts = []) {
    const haystack = [providerName, title].filter(Boolean).join(' ').toLowerCase().trim();
    if (!haystack) return null;

    // 1. Check existing contracts with same provider that already have an emergency_contact
    const cleanProvider = String(providerName || '').trim().toLowerCase();
    if (cleanProvider.length >= 3) {
      for (const c of existingContracts) {
        if (
          c.emergency_contact &&
          c.emergency_contact.trim() &&
          String(c.provider_name || '').trim().toLowerCase() === cleanProvider
        ) {
          return {
            contact: c.emergency_contact.trim(),
            source: 'Bestehender Vertrag'
          };
        }
      }
    }

    // 2. Check offline providers_contacts.json
    const list = await loadCatalog();
    if (Array.isArray(list)) {
      for (const entry of list) {
        const keywords = Array.isArray(entry.keywords) ? entry.keywords : [entry.provider || entry.name];
        if (keywords.some((kw) => matchesKeyword(haystack, kw))) {
          const formatted = entry.contact || entry.emergency_contact || '';
          if (formatted) {
            return {
              contact: formatted,
              source: 'Offline-Anbieterverzeichnis'
            };
          }
        }
      }
    } else if (list && typeof list === 'object') {
      for (const [key, val] of Object.entries(list)) {
        if (matchesKeyword(haystack, key)) {
          const text = typeof val === 'string' ? val : (val.contact || val.emergency_contact || '');
          if (text) {
            return { contact: text, source: 'Offline-Anbieterverzeichnis' };
          }
        }
      }
    }

    return null;
  }

  return {
    loadCatalog,
    lookup
  };
})();
