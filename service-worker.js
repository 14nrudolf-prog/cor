/* global chrome */
importScripts('util/csv.js', 'util/snapshot.js', 'util/storage.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_DETAIL_TABS_PER_BATCH = 20;

// Open Options page when the toolbar icon is clicked (no popup)
chrome.action.onClicked.addListener(() => {
  if (chrome.runtime && typeof chrome.runtime.openOptionsPage === 'function') {
    try { chrome.runtime.openOptionsPage(); } catch (e) {}
  } else {
    // Fallback: open the options URL directly
    const url = chrome.runtime.getURL('options/index.html');
    try { chrome.tabs.create({ url }); } catch (e) {}
  }
});

function sendToTab(tabId, msg) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, msg, resp => {
      if (chrome.runtime.lastError) {
        console.warn('[SW] sendToTab error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(resp != null ? resp : true);
      }
    });
  });
}

async function waitForContentScript(tabId, tries = 20, delay = 250) {
  for (let i = 0; i < tries; i++) {
    const resp = await sendToTab(tabId, { type: 'PING' });
    if (resp && resp.ok) return true;
    await sleep(delay);
  }
  return false;
}

let currentUpdate = null;

chrome.runtime.onMessage.addListener((msg, sender) => {

  
  console.log('[SW] got message:', msg, 'from', sender);

  switch (msg.type) {

    case 'UPDATE_REQUEST': {
      // popup sends the active tab explicitly
  const { tabId, daysWindow = 2, dropRecent = 0 } = msg;
      if (typeof tabId !== 'number') {
        console.warn('[SW] UPDATE_REQUEST missing tabId – cannot start update.');
        return;
      }
  return doUpdate(tabId, { daysWindow, dropRecent });
    }

    case 'LIST_DATA': {
      // from content/list.js on the list page
      console.log('[SW] LIST_DATA count=', (msg.listData && msg.listData.length));
      return handleListData(msg.listData || []);
    }

    case 'DETAILS_DATA': {
      // from content/details.js in each details tab
      const detailTabId = sender.tab && sender.tab.id; // content script messages DO have sender.tab
      if (detailTabId == null) {
        console.warn('[SW] DETAILS_DATA without sender.tab – skipping close');
      }
      return handleDetailsData(msg.data, detailTabId);
    }

    case 'GENERATE_OVERVIEW': {
      return generateOverview(msg.csvText);
    }

    case 'SCRAPE_TO_STORE': {
      return scrapeToStore();
    }

    default:
      return;
  }
});
/**
 * Kick off the update: ask the list-page content script for its snapshot.
 */
async function doUpdate(listTabId, opts) {

  if (currentUpdate) return;  // already in progress
  currentUpdate = {
    listMap: {},
    remainingIds: new Set(),
    listTabId,
    daysWindow: opts.daysWindow,   // <—
    dropRecent: opts.dropRecent    // <—
  };

    const ready = await waitForContentScript(listTabId);
  if (!ready) {
    console.warn('[SW] list content script not ready');
    currentUpdate = null;
    return;
  }
  const ack = await sendToTab(listTabId, { type: 'GET_LIST_DATA' });
  if (!ack) {
    console.warn('[SW] GET_LIST_DATA not acknowledged');
    currentUpdate = null;
    return;
  }
}


/**
 * Receives the bulk of your columns from the list view.
 *   - Stores them in listMap
 *   - Opens one hidden tab per ID to fetch the 3 extra fields
 */
async function handleListData(listData) {
  if (!currentUpdate) return;
  if (currentUpdate.listStarted) {
    console.warn('[SW] LIST_DATA duplicate ignored');
    return;
  }
  currentUpdate.listStarted = true;

  // 1) Map current list rows (active WOs)
  listData.forEach(row => { currentUpdate.listMap[row.ID] = { ...row }; });

  // 2) Load latest previous snapshot and find IDs that disappeared
  const all = await chrome.storage.local.get(null);
  const prevKey = Object.keys(all).filter(k => /^snapshot_/.test(k)).sort().pop();
  const prevSnap = prevKey ? all[prevKey] : {};

  const currentIds = new Set(listData.map(r => r.ID));
  const extraIds = Object.keys(prevSnap).filter(id => !currentIds.has(id)); // likely Completed/Cancelled

  // 3) Init tracking for statuses of now-inactive WOs
  currentUpdate.inactiveStatus = {}; // { id: 'Completed'|'Cancelled'|… }

  // 4) Open details (for store-mode, only current IDs)
  const idsToFetch = currentUpdate.mode === 'store' ? [...currentIds] : [...currentIds, ...extraIds];
  idsToFetch.forEach(id => currentUpdate.remainingIds.add(id));

  // Batch detail tabs so we don't overload the browser; manual expansion of activity logs still happens per tab.
  currentUpdate.detailQueue = idsToFetch.slice();
  currentUpdate.activeBatchIds = new Set();
  currentUpdate.batchSize = MAX_DETAIL_TABS_PER_BATCH;
  openNextDetailsBatch();
}

function openNextDetailsBatch() {
  if (!currentUpdate) return;
  const queue = currentUpdate.detailQueue || [];
  if (!queue.length) return;
  if (currentUpdate.activeBatchIds && currentUpdate.activeBatchIds.size > 0) return; // still processing

  const batchSize = currentUpdate.batchSize || MAX_DETAIL_TABS_PER_BATCH;
  const batch = queue.splice(0, batchSize);
  currentUpdate.activeBatchIds = new Set(batch);

  batch.forEach(id => {
    chrome.tabs.create({
      url: `https://jll-oracle.corrigo.com/corpnet/workorder/workorderdetails.aspx/${id}`,
      active: false
    });
  });
  console.log(`[SW] opened details batch of ${batch.length}; ${queue.length} remaining`);
}

/**
 * Called by content/details.js on each detail tab.
 *   - Merges the three extra fields into listMap[ID]
 *   - Closes the tab
 *   - When all are in, calls finishUpdate()
 */
let DEBUG_DETAILS = false;   // <-- set true to pause & keep tabs open

async function handleDetailsData(details, tabId) {
  if (!currentUpdate) return;
  console.log('[SW] DETAILS_DATA:', details);

  const { ID } = details;
  if (currentUpdate.listMap[ID]) {
    Object.assign(currentUpdate.listMap[ID], {
      Status: details.Status,
      'Activity log': details['Activity log'],
      'Procedures progress': details['Procedures progress']
    });
  } else {
    currentUpdate.inactiveStatus = currentUpdate.inactiveStatus || {};
    currentUpdate.inactiveStatus[ID] = details.Status;
  }

  // mark done for this ID
  currentUpdate.remainingIds.delete(ID);
  if (currentUpdate.activeBatchIds) currentUpdate.activeBatchIds.delete(ID);
  if (currentUpdate.activeBatchIds && currentUpdate.activeBatchIds.size === 0) {
    openNextDetailsBatch();
  }

  // keep the tab open in debug mode
  if (!DEBUG_DETAILS && tabId) chrome.tabs.remove(tabId);

  // in debug mode: do not finish automatically
  if (!DEBUG_DETAILS && currentUpdate.remainingIds.size === 0) {
    try {
      if (currentUpdate.mode === 'csv_update') {
        await finishUpdate();
      } else {
        await finishScrapeToStore();
      }
    } catch (e) {
      console.error(e);
    }
    currentUpdate = null;       // <-- null AFTER finishUpdate completes
  }
}

// ---------- New flow: Scrape to Store (Options page) ----------
function tabsQuery(queryInfo) {
  return new Promise(resolve => chrome.tabs.query(queryInfo, resolve));
}
function tabsCreate(createProps) {
  return new Promise(resolve => chrome.tabs.create(createProps, resolve));
}

async function openOrFocusListTab() {
  // Create and focus a fresh list tab so it’s visible to the user
  const t = await tabsCreate({ url: 'https://jll-oracle.corrigo.com/corpnet/workorder/workorderlist.aspx', active: true });
  return t && t.id;
}

function tabsGet(tabId) {
  return new Promise(resolve => {
    try { chrome.tabs.get(tabId, t => resolve(t)); }
    catch (e) { resolve(null); }
  });
}

async function ensureListContentScript(tabId) {
  // Try a ping; if no response, attempt explicit injection
  const ping = await sendToTab(tabId, { type: 'PING' });
  if (ping && ping.ok) return true;
  try { await executeScriptFiles(tabId, ['content/list.js']); } catch (e) {}
  const ping2 = await sendToTab(tabId, { type: 'PING' });
  return !!(ping2 && ping2.ok);
}

async function waitForDailyOverview(tabId, timeoutMs = 300000) { // up to 5 minutes to allow login + nav
  const start = Date.now();
  let alerted = false;
  while (Date.now() - start < timeoutMs) {
    const t = await tabsGet(tabId);
    if (!t) return false;
    const url = (t.url || '').toLowerCase();
    const isList = url.includes('/corpnet/workorder/workorderlist.aspx');
    const isLogin = url.includes('/corpnet/login.aspx');

    if (isList) {
      const ready = await ensureListContentScript(tabId);
      if (!ready) { await sleep(1000); continue; }
      // First time on list page and wrong view: alert once and continue
      if (!alerted) {
        const resp0 = await sendToTab(tabId, { type: 'CHECK_AND_ALERT_DAILY_OVERVIEW' });
        if (resp0 && resp0.ok) return true;
        alerted = true;
      }
      const resp = await sendToTab(tabId, { type: 'CHECK_DAILY_OVERVIEW' });
      if (resp && resp.ok) return true;
    }
    // If login or elsewhere, just keep waiting
    await sleep(1000);
  }
  return false;
}

function executeScriptFiles(tabId, files) {
  return new Promise((resolve, reject) => {
    try {
      chrome.scripting.executeScript({ target: { tabId }, files }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function scrapeToStore() {
  console.log(111)
  if (currentUpdate) return; // skip if already scraping
  console.log(222)
  const listTabId = await openOrFocusListTab();
  if (listTabId == null) return;

  // robustly wait across login/navigation until Daily Overview is selected
  const okView = await waitForDailyOverview(listTabId);
  if (!okView) {
    console.warn('[SW] Daily Overview not selected within timeout');
    return;
  }

  // init update state for store-mode
  currentUpdate = {
    listMap: {},
    remainingIds: new Set(),
    listTabId,
    daysWindow: 0,
    dropRecent: 0,
    mode: 'store'
  };

  const ack = await sendToTab(listTabId, { type: 'GET_LIST_DATA' });
  if (!ack) {
    console.warn('[SW] GET_LIST_DATA not acknowledged');
    currentUpdate = null;
    return;
  }
}

async function finishScrapeToStore() {
  // Merge list+details into wo_store
  const listRows = Object.values(currentUpdate.listMap || {});
  const { seenIds } = await WOStore.upsertFromListRows(listRows);
  for (const id of Object.keys(currentUpdate.listMap)) {
    const r = currentUpdate.listMap[id];
    // merge details for each
    await WOStore.mergeDetails(id, {
      Status: r.Status,
      'Activity log': r['Activity log'] || []
    });
  }
  // Mark inactives
  await WOStore.setInactiveForMissing([...seenIds]);
  // Update last scrape timestamp
  const store = await WOStore.getStore();
  store.lastScrapeAt = Date.now();
  await WOStore.setStore(store);
  // Close the list tab we opened and notify UI to refresh
  try { if (currentUpdate.listTabId) chrome.tabs.remove(currentUpdate.listTabId); } catch (e) {}
  try { chrome.runtime.sendMessage({ type: 'STORE_UPDATED' }); } catch (e) {}
}



/**
 * Once all list+detail data is in listMap:
 * 1) snapshot to storage
 * 2) diff vs. prior snapshot
 * 3) CSV-&-download
 */
async function finishUpdate() {
  const timestamp = Date.now();
  const snapKey   = `snapshot_${timestamp}`;
  const snapshot  = { ...currentUpdate.listMap };

    // 1a) DEBUG: trim newest N activity-log entries when saving the snapshot
  const n = currentUpdate.dropRecent || 0;
  if (n > 0) {
    for (const id of Object.keys(snapshot)) {
      const log = snapshot[id]['Activity log'];
      if (Array.isArray(log) && log.length > n) {
        snapshot[id]['Activity log'] = log.slice(n); // drop newest n
      }
    }
  }

  await chrome.storage.local.set({ [snapKey]: snapshot });

  const all      = await chrome.storage.local.get(null);
  const prevKey  = Object.keys(all).filter(k => /^snapshot_/.test(k) && k !== snapKey).sort().pop();
  const prevSnap = prevKey ? all[prevKey] : {};
  const commentsLatest = all.comments_latest || {}; // { ID: "last user comment" }

// Build union of all previously-seen activity log items across ALL older snapshots
function logKey(it) {
  return [
    (it && it.ActionDateTime) || '',
    (it && it.ActionBy) || '',
    (it && it.ActionTitle) || '',
    (it && it.Comment) || ''
  ].join('||');
}

const knownLogKeysById = Object.create(null); // { ID: Set<string> }

for (const k of Object.keys(all)) {
  if (!k.startsWith('snapshot_') || k === snapKey) continue; // only older snaps
  const snap = all[k];
  if (!snap || typeof snap !== 'object') continue;
  for (const [id, row] of Object.entries(snap)) {
    const arr = row && row['Activity log'];
    if (!Array.isArray(arr)) continue;
    let set = knownLogKeysById[id];
    if (!set) knownLogKeysById[id] = set = new Set();
    for (const it of arr) set.add(logKey(it));
  }
}

const diffedRows = diffSnapshots(prevSnap, snapshot, {
  inactiveStatus: currentUpdate.inactiveStatus || {},
  prevComments: commentsLatest,
  knownLogKeysById
});

// Save the diff so the Overview page can render from it
const diffKey = `diff_${timestamp}`;
await chrome.storage.local.set({
  [diffKey]: diffedRows,
  diff_latest: diffedRows
});

// 4) FORMAT for CSV:
//    - sort by Due date (ascending; invalid dates go last)
//    - pretty-print Activity log (last N days, multi-line)
//    - keep ONLY the requested columns, in this exact order
const days = currentUpdate.daysWindow || 2;

const sorted = diffedRows.slice().sort((a, b) => {
  const da = new Date(a['Due date']);
  const db = new Date(b['Due date']);
  const ta = isNaN(da) ? Number.POSITIVE_INFINITY : da.getTime();
  const tb = isNaN(db) ? Number.POSITIVE_INFINITY : db.getTime();
  return ta - tb;
});

const rowsForCsv = sorted.map(src => ({
  'WO nr': src['WO nr'] || '',
  'Description': src['Description'] || '',
  'Activity log': formatLogCell(src['Activity log'], days),
  'Updated': src['Updated'] || '',
  'Comment / last update (previous)': src['Comment / last update (previous)'] || '',
  'Comment / last update (new)': src['Comment / last update (new)'] || ''
}));

 // 5) CSV & download
  const csvText = rowsToCsv(rowsForCsv);
  const csvWithBom = '\uFEFF' + csvText; // BOM for Excel
  const dataUrl    = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvWithBom);

  await chrome.downloads.download({
    url: dataUrl,
    filename: `updates_${timestamp}.csv`,
    saveAs: true
  });
}

/* ---------------------------------------------------------------- */
/* “Generate Overview” code remains unchanged from your prior version */
/* ---------------------------------------------------------------- */
function generateOverview(csvText) {
  const rows = parseCsv(csvText);

  // Build maps
  const newComments = {};
  const commentsLatest = {}; // what Update will use as "previous"

  const normId = v => String(v == null ? '' : v).trim();
  const pick = (o, keys) => {
    for (const k of keys) {
      const v = o[k];
      if (v != null && String(v).trim() !== '') return String(v);
    }
    return '';
  };

  rows.forEach(r => {
    const id = normId((r.ID != null ? r.ID : (r['ID'] != null ? r['ID'] : (r['Id'] != null ? r['Id'] : r['id']))));
    if (!id) return;

    // prefer the user's new comment; if empty, you can decide to keep '' or fall back to previous
    const newC = pick(r, [
      'Comment / last update (new)',
      'Comment / Last update (new)'
    ]).trim();

    const prevC = pick(r, [
      'Comment / last update (previous)',
      'Comment / Last update (previous)'
    ]).trim();

    newComments[id] = newC;                 // used by overview page overlay
    commentsLatest[id] = newC || prevC || '';// used by next UPDATE as "previous"
  });

  console.log('[gen] storing overview_new_comments:', newComments);
  console.log('[gen] storing comments_latest:', commentsLatest);

  chrome.storage.local.set(
    { overview_new_comments: newComments, comments_latest: commentsLatest },
    () => {
      if (chrome.runtime.lastError) {
        console.error('[gen] storage.set error:', chrome.runtime.lastError.message);
        return;
      }
      chrome.tabs.create({ url: chrome.runtime.getURL('overview.html') });
    }
  );
}

function parseDateLoose(s) {
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function formatLogItem(i) {
  // Order: timestamp, author, type, message
  const ts = i.ActionDateTime || '';
  const by = i.ActionBy || '';
  const ty = i.ActionTitle || '';
  const msg = i.Comment || '';
  return [ts, by, ty, msg].filter(Boolean).join(' — ');
}

function formatLogCell(log, daysWindow) {
  if (!Array.isArray(log)) return '';
  const cutoff = Date.now() - daysWindow * 864e5;
  const lines = log
    .filter(it => {
      const d = parseDateLoose(it.ActionDateTime);
      return d && d.getTime() >= cutoff;
    })
    .map(formatLogItem);
  // join with \n so Excel shows each entry on a new line (Wrap Text on)
  return lines.join('\n');
}


function buildOverview(rows) {
  document.title = 'WO Overview';
  const cfg = {
    cell:   'border:1px solid #ccc;padding:2px 4px;white-space:nowrap;font:12px/1.4 Calibri,"Segoe UI",sans-serif;',
    header: 'border:1px solid #ccc;padding:2px 4px;background:#f5f5f5;font-weight:600;font:12px/1.4 Calibri,"Segoe UI",sans-serif;'
  };
  const table = document.createElement('table');
  table.style.borderCollapse = 'collapse';

  // header
  const thead = table.createTHead();
  const hr    = thead.insertRow();
  Object.keys(rows[0]).forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    th.setAttribute('style', cfg.header);
    hr.appendChild(th);
  });

  // body
  const today = new Date(); today.setHours(0,0,0,0);
  const soon  = new Date(today); soon.setDate(soon.getDate()+7);
  const tbody = table.createTBody();

  rows.sort((a,b) => new Date(a['Due date']) - new Date(b['Due date']));
  rows.forEach(r => {
    const tr = tbody.insertRow();
    const d  = new Date(r['Due date']); d.setHours(0,0,0,0);
    if (d < today)       tr.style.background = '#ffdddd';
    else if (d <= soon)  tr.style.background = '#ffffcc';

    Object.values(r).forEach(val => {
      const td = tr.insertCell();
      td.textContent = val;
      td.setAttribute('style', cfg.cell);
    });
  });

  document.body.appendChild(table);
}
