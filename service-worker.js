/* global chrome */
importScripts('util/csv.js', 'util/snapshot.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sendToTab(tabId, msg) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, msg, resp => {
      if (chrome.runtime.lastError) {
        console.warn('[SW] sendToTab error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(resp ?? true);
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
      console.log('[SW] LIST_DATA count=', msg.listData?.length);
      return handleListData(msg.listData || []);
    }

    case 'DETAILS_DATA': {
      // from content/details.js in each details tab
      const detailTabId = sender.tab?.id; // content script messages DO have sender.tab
      if (detailTabId == null) {
        console.warn('[SW] DETAILS_DATA without sender.tab – skipping close');
      }
      return handleDetailsData(msg.data, detailTabId);
    }

    case 'GENERATE_OVERVIEW': {
      return generateOverview(msg.csvText);
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

  // 4) Open details for both current IDs and extra IDs
  const idsToFetch = [...currentIds, ...extraIds];
  idsToFetch.forEach(id => currentUpdate.remainingIds.add(id));

  idsToFetch.forEach(id => {
    chrome.tabs.create({
      url: `https://jll-oracle.corrigo.com/corpnet/workorder/workorderdetails.aspx/${id}`,
      active: false
    });
  });
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
    currentUpdate.inactiveStatus ||= {};
    currentUpdate.inactiveStatus[ID] = details.Status;
  }

  // mark done for this ID
  currentUpdate.remainingIds.delete(ID);

  // keep the tab open in debug mode
  if (!DEBUG_DETAILS && tabId) chrome.tabs.remove(tabId);

  // in debug mode: do not finish automatically
  if (!DEBUG_DETAILS && currentUpdate.remainingIds.size === 0) {
    try {
      await finishUpdate();     // <-- wait
    } catch (e) {
      console.error(e);
    }
    currentUpdate = null;       // <-- null AFTER finishUpdate completes
  }
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
    it?.ActionDateTime || '',
    it?.ActionBy || '',
    it?.ActionTitle || '',
    it?.Comment || ''
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

  const normId = v => String(v ?? '').trim();
  const pick = (o, keys) => {
    for (const k of keys) {
      const v = o[k];
      if (v != null && String(v).trim() !== '') return String(v);
    }
    return '';
  };

  rows.forEach(r => {
    const id = normId(r.ID ?? r['ID'] ?? r['Id'] ?? r['id']);
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
