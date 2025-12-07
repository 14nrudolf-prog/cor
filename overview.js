async function renderFromStorage() {
  document.title = 'WO Overview';
  const all = await chrome.storage.local.get(null);
  const store = all.wo_store;
  if (store && store.wos) {
    const rows = buildRowsFromStore(store);
    renderOverview(rows);
    return;
  }

  // Legacy fallbacks to keep old flows working if store is not populated yet
  const diffRows = Array.isArray(all.diff_latest) ? all.diff_latest : [];
  const newComments = all.overview_new_comments || {};
  if (diffRows.length) {
    const rows = buildRowsFromDiff(diffRows, newComments);
    renderOverview(rows);
    return;
  }
  const snapKeys = Object.keys(all).filter(k => k.startsWith('snapshot_'));
  const snapKey = snapKeys.sort((a, b) => Number(a.slice(9)) - Number(b.slice(9))).pop();
  const snap = snapKey ? all[snapKey] : {};
  const prevComments = all.comments_latest || {};
  const rows = buildRowsFromSnapshot(snap, newComments, prevComments);
  renderOverview(rows);
}

(function init() {
  renderFromStorage();
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes && changes.wo_store) {
        renderFromStorage();
      }
    });
  } catch (e) {
    // no-op
  }
})();

function parseDateLoose(s) {
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function latestLogDateStr(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  var s = arr[0] && arr[0].ActionDateTime;
  return s || '';
}

function getPickupDate(arr) {
  if (!Array.isArray(arr) || !arr.length) return '-';
  let minTime = Infinity; let earliestStr = null;
  for (const i of arr) {
    const title = (i.ActionTitle || '').toLowerCase();
    if (!title.includes('picked up')) continue;
    const d = parseDateLoose(i.ActionDateTime);
    if (d) { const t = d.getTime(); if (t < minTime) { minTime = t; earliestStr = i.ActionDateTime || '-'; } }
  }
  return earliestStr || '-';
}

function buildRowsFromStore(store) {
  const rows = [];
  for (const wo of Object.values(store.wos || {})) {
    // Skip inactive WOs in the overview
    if (wo && wo.inactive) continue;
    const cur = wo.lastUpdate && wo.lastUpdate.current;
    var author = cur && cur.actionBy ? String(cur.actionBy).trim() : '';
    var text   = cur && cur.text ? String(cur.text).trim() : '';
    function formatLastUpdate(a, t) {
      var me = 'Lilian Canete-Theobald';
      if (!a) return t;
      if (a === me) return t;
      var first = (a.split(/\s+/)[0]) || a;
      return t ? (first + ': ' + t) : (first + ':');
    }
    // If last update text is empty, do not show a date in overview
    var dateForOverview = '';
    if (text && (cur && cur.dateOfLastUpdate)) {
      dateForOverview = cur.dateOfLastUpdate;
    }
    rows.push({
      ID: wo.id || '',
      'WO nr': wo.woNumber || '',
      'Due date': wo.dueDate || '',
      'Description': wo.description || '',
      'Date of Last update': dateForOverview,
      'Last update': formatLastUpdate(author, text),
      'Pick-up date': getPickupDate(wo.activityLog),
      'KPI exemption': wo.kpiExemption || '',
      'KPI exemption reason': wo.kpiExemptionReason || ''
    });
  }
  return rows;
}

function buildRowsFromDiff(diffRows, newComments) {
  return diffRows.map(r => {
    const id = String(r.ID || '').trim();
    const combinedComment =
      (newComments[id] && newComments[id].trim()) ||
      (r['Comment / last update (new)'] || '').trim() ||
      (r['Comment / last update (previous)'] || '').trim() ||
      '';
    var showDate = combinedComment && combinedComment.trim().length > 0;
    return {
      ID: id,
      'WO nr': r['WO nr'] || '',
      'Due date': r['Due date'] || '',
      'Description': r['Description'] || '',
      'Date of Last update': showDate ? (latestLogDateStr(r['Activity log']) || '') : '',
      'Last update': combinedComment,
      'Pick-up date': getPickupDate(r['Activity log']),
      'KPI exemption': r['KPI exemption'] || '',
      'KPI exemption reason': r['KPI exemption reason'] || '',
      'Updated': r['Updated'] || ''
    };
  });
}

function latestLogText(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  const i = arr[0];
  const parts = [i.ActionDateTime, i.ActionBy, i.ActionTitle, i.Comment].filter(Boolean);
  return parts.join(' - ');
}

function buildRowsFromSnapshot(snap, newComments, prevComments) {
  return Object.values(snap).map(r => {
    const id = String(r.ID || '').trim();
    const fromNew  = (newComments[id] || '').trim();
    const fromPrev = (prevComments[id] || '').trim();
    const fromLog  = latestLogText(r['Activity log']);
    const comment = fromNew || fromPrev || fromLog;
    return {
      ID: id,
      'WO nr': r['WO nr'] || '',
      'Due date': r['Due date'] || '',
      'Description': r['Description'] || '',
      'Date of Last update': latestLogDateStr(r['Activity log']) || '',
      'Last update': comment || '',
      'Pick-up date': getPickupDate(r['Activity log']),
      'KPI exemption': r['KPI exemption'] || '',
      'KPI exemption reason': r['KPI exemption reason'] || ''
    };
  });
}

// Columns and layout (new order)
const TOTAL_PX = 1440;
const COLS_DEF = [
  { key: 'WO nr',                    px: 200 },
  { key: 'Due date',                 px: 140 },
  { key: 'Description',              px: 360 },
  { key: 'Date of Last update',      px: 160 },
  { key: 'Last update',              px: 340 },
  { key: 'Pick-up date',             px: 140 },
  { key: 'KPI exemption',            px: 100 },
  { key: 'KPI exemption reason',     px: 160 }
];

function renderOverview(rows) {
  rows.sort((a,b) => new Date(a['Due date']) - new Date(b['Due date']));
  const table = document.getElementById('tbl');
  // reset table
  table.innerHTML = '';
  table.style.cssText = 'border-collapse:collapse;font:12px/1.4 Calibri,\"Segoe UI\",sans-serif';
  table.style.width = TOTAL_PX + 'px';
  table.style.tableLayout = 'fixed';
  const colgroup = document.createElement('colgroup');
  COLS_DEF.forEach(c => { const col = document.createElement('col'); col.style.width = c.px + 'px'; colgroup.appendChild(col); });
  table.appendChild(colgroup);
  const thead = table.createTHead();
  const hr = thead.insertRow();
  COLS_DEF.forEach(c => { const th = document.createElement('th'); th.textContent = c.key; th.style.cssText = 'border:1px solid #000;padding:2px 4px;background:#f5f5f5;font-weight:600;white-space:nowrap'; hr.appendChild(th); });
  const tbody = table.createTBody();
  const keyDue = 'Due date';
  // Determine base date (today or tomorrow) via query param
  const params = new URLSearchParams(location.search);
  const asOf = params.get('asOf');
  const base = new Date(); base.setHours(0,0,0,0);
  if (asOf === 'tomorrow') base.setDate(base.getDate() + 1);

  rows.forEach(r => {
    const tr = tbody.insertRow();
    // compute due-state
    var dueStr = r[keyDue] || '';
    var d = new Date(dueStr);
    var today = base;
    var dueMid = new Date(d); if (!isNaN(dueMid)) dueMid.setHours(0,0,0,0);
    var bg = '';
    var suffix = '';
    if (!isNaN(dueMid)) {
      var diffDays = Math.floor((dueMid.getTime() - today.getTime())/86400000);
      var hasEx = (r['KPI exemption'] && String(r['KPI exemption']).trim().length > 0);
      if (diffDays < 0) { // overdue (no suffix after overdue)
        bg = hasEx ? '#FFDDDD' : '#FFB3B3';
        suffix = '';
      } else if (diffDays === 0) { // today
        bg = hasEx ? '#FFDDDD' : '#FFB3B3';
        suffix = ' (overdue today)';
      } else if (diffDays === 1) {
        bg = '#FFF2CC';
        suffix = ' (overdue tomorrow)';
      } else if (diffDays < 7) {
        bg = '#FFF2CC';
        suffix = ' (overdue in ' + diffDays + ' days)';
      }
      if (bg) tr.style.background = bg;
    }
    COLS_DEF.forEach(c => {
      const td = tr.insertCell();
      var baseStyle = 'border:1px solid #000;padding:2px 4px;';
      var wrap = (c.key === 'Description' || c.key === 'Last update' || c.key === 'Due date' || c.key === 'KPI exemption' || c.key === 'KPI exemption reason');
      baseStyle += wrap ? 'white-space:normal;word-wrap:break-word;' : 'white-space:nowrap;';
      td.style.cssText = baseStyle;
      if (c.key === 'WO nr' && r.ID && r[c.key]) {
        const a = document.createElement('a');
        a.href = `https://jll-oracle.corrigo.com/corpnet/workorder/workorderdetails.aspx/${r.ID}`;
        a.target = '_blank'; a.rel = 'noopener';
        a.textContent = r[c.key];
        a.style.cssText = 'color:#06c;text-decoration:none;border:none;font:inherit;';
        td.appendChild(a);
      } else if (c.key === keyDue) {
        td.textContent = (r[c.key] != null ? (String(r[c.key]) + suffix) : '');
      } else {
        td.textContent = (r[c.key] != null ? r[c.key] : '');
      }
    });
  });
  // keep greeting/closing text; table already appended in DOM
}
