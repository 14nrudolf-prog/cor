/* global chrome */
// Lightweight storage layer for WOs in chrome.storage.local (no direct IndexedDB usage)
// Shape:
//   wo_store = {
//     wos: {
//       [id]: {
//         id, woNumber, dueDate, description,
//         kpiExemption, kpiExemptionReason,
//         status, inactive: boolean,
//         lastSeenAt: number,
//         activityLog: Array<{ ActionDateTime, ActionBy, ActionTitle, Comment, _key }>,
//         lastUpdate: {
//           current?: { text, actionBy, dateOfLastUpdate, selectedLogKeys?: string[], changedAt: number },
//           history?: Array<{ text, actionBy, dateOfLastUpdate, selectedLogKeys?: string[], changedAt: number }>
//         }
//       }
//     },
//     lastScrapeAt?: number
//   }

(function (root) {
  const STORAGE_KEY = 'wo_store';
  const MAX_BYTES = 4 * 1024 * 1024; // ~4MB budget target; trim if we go beyond

  function now() { return Date.now(); }

  function ensure(obj, key, defVal) {
    if (obj[key] == null) obj[key] = defVal;
    return obj[key];
  }

  function jsonBytes(o) {
    try { return new TextEncoder().encode(JSON.stringify(o)).length; }
    catch (e) { return JSON.stringify(o || {}).length * 2; }
  }

  function normalizeId(id) { return String(id == null ? '' : id).trim(); }

  function makeLogKey(it) {
    return [
      (it && it.ActionDateTime) || '',
      (it && it.ActionBy) || '',
      (it && it.ActionTitle) || '',
      (it && it.Comment) || ''
    ].join('||');
  }

  async function getStore() {
    const all = await chrome.storage.local.get(STORAGE_KEY);
    const store = all[STORAGE_KEY] || { wos: {} };
    if (!store.wos) store.wos = {};
    return store;
  }

  async function setStore(store) {
    // trim if too large
    let bytes = jsonBytes(store);
    if (bytes > MAX_BYTES) {
      await trimStore(store, bytes);
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
  }

  async function trimStore(store, currentBytes) {
    const target = MAX_BYTES * 0.8; // trim down to 80%
    const entries = Object.values(store.wos);
    entries.sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0)); // oldest first
    let idx = 0;
    while ((currentBytes > target) && idx < entries.length) {
      const victim = entries[idx++];
      if (!victim) break;
      delete store.wos[victim.id];
      currentBytes = jsonBytes(store);
    }
  }

  async function upsertFromListRows(rows) {
    const store = await getStore();
    const seenIds = new Set();
    const t = now();
    for (const r of rows) {
      const id = normalizeId(r.ID);
      if (!id) continue;
      seenIds.add(id);
      const wo = ensure(store.wos, id, { id });
      wo.id = id;
      wo.woNumber = r['WO nr'] || wo.woNumber || '';
      wo.dueDate = r['Due date'] || wo.dueDate || '';
      wo.description = r['Description'] || wo.description || '';
      wo.kpiExemption = r['KPI exemption'] || wo.kpiExemption || '';
      wo.kpiExemptionReason = r['KPI exemption reason'] || wo.kpiExemptionReason || '';
      wo.status = r.Status || wo.status || '';
      wo.inactive = false;
      wo.lastSeenAt = t;
    }
    await setStore(store);
    return { store, seenIds };
  }

  async function setInactiveForMissing(activeIds) {
    const store = await getStore();
    const set = new Set(activeIds.map(normalizeId));
    const t = now();
    for (const id of Object.keys(store.wos)) {
      if (!set.has(id)) {
        const wo = store.wos[id];
        wo.inactive = true;
        if (!wo.lastSeenAt) wo.lastSeenAt = t;
      }
    }
    await setStore(store);
  }

  async function mergeDetails(id, details) {
    id = normalizeId(id);
    if (!id) return;
    const store = await getStore();
    const wo = ensure(store.wos, id, { id });
    wo.status = details.Status || wo.status || '';
    const arr = Array.isArray(details['Activity log']) ? details['Activity log'] : [];
    // ensure stable keys on log rows to track selections
    wo.activityLog = arr.map(it => ({ ...it, _key: makeLogKey(it) }));
    wo.lastSeenAt = now();
    await setStore(store);
  }

  function mostRecentDateString(strings) {
    let best = null; // { d: Date, s: string }
    for (const s of (strings || [])) {
      const d = s && new Date(s);
      if (d && !isNaN(d)) {
        if (!best || d > best.d) best = { d, s };
      }
    }
    return best ? best.s : '';
  }

  async function changeLastUpdateFromSelection(id, selectedKeys) {
    id = normalizeId(id);
    const store = await getStore();
    const wo = store.wos[id];
    if (!wo) return { ok: false, error: 'WO not found' };
    const items = (wo.activityLog || []).filter(it => selectedKeys.includes(it._key));
    if (!items.length) return { ok: false, error: 'No items selected' };

    const authors = new Set(items.map(i => i.ActionBy || ''));
    if (authors.size > 1) return { ok: false, error: 'Selected items have different ActionBy' };

    const actionBy = items[0].ActionBy || '';
    const text = items.map(i => i.Comment || '').join('\n\n').trim();
    const dateOfLastUpdate = mostRecentDateString(items.map(i => i.ActionDateTime || ''));
    const entry = {
      text,
      actionBy,
      dateOfLastUpdate,
      selectedLogKeys: selectedKeys.slice(),
      changedAt: now()
    };
    const lu = ensure(wo, 'lastUpdate', {});
    if (!lu.history) lu.history = [];
    if (lu.current) lu.history.unshift(lu.current);
    lu.current = entry;
    // Also record this as an explicit version history item (so user doesn't need to click "New item")
    lu.history.unshift(entry);
    await setStore(store);
    return { ok: true };
  }

  async function saveLastUpdateEdit(id, { text, actionBy, createNew, dateOfLastUpdate }) {
    id = normalizeId(id);
    const store = await getStore();
    const wo = store.wos[id];
    if (!wo) return { ok: false, error: 'WO not found' };
    const lu = ensure(wo, 'lastUpdate', {});
    if (!lu.history) lu.history = [];
    const base = lu.current || { text: '', actionBy: '', dateOfLastUpdate: '', selectedLogKeys: [] };
    const updated = {
      text: (((text !== undefined && text !== null) ? text : (base.text || '')) + '').trim(),
      actionBy: (((actionBy !== undefined && actionBy !== null) ? actionBy : (base.actionBy || '')) + '').trim(),
      dateOfLastUpdate: (dateOfLastUpdate !== undefined && dateOfLastUpdate !== null && String(dateOfLastUpdate).trim() !== '')
        ? String(dateOfLastUpdate).trim()
        : (base.dateOfLastUpdate || ''),
      selectedLogKeys: base.selectedLogKeys || [],
      changedAt: now()
    };
    if (createNew && lu.current) lu.history.unshift(lu.current);
    lu.current = updated;
    await setStore(store);
    return { ok: true };
  }

  root.WOStore = {
    getStore,
    setStore,
    upsertFromListRows,
    setInactiveForMissing,
    mergeDetails,
    changeLastUpdateFromSelection,
    saveLastUpdateEdit
  };
})(typeof window === 'undefined' ? self : window);
