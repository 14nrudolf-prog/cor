(async function () {
  document.title = 'WO Overview';

  const all = await chrome.storage.local.get(null);

  // Use latest diff produced by Update
  const diffRows    = Array.isArray(all.diff_latest) ? all.diff_latest : [];
  const newComments = all.overview_new_comments || {};

  if (diffRows.length) {
    const rows = buildRowsFromDiff(diffRows, newComments);
    renderOverview(rows);
    return;
  }

  // Fallback to snapshot if diff not present (keeps old behavior)
  const snapKeys = Object.keys(all).filter(k => k.startsWith('snapshot_'));
  const snapKey = snapKeys.sort((a, b) => Number(a.slice(9)) - Number(b.slice(9))).pop();
  const snap = snapKey ? all[snapKey] : {};
  const prevComments = all.comments_latest || {};
  const rows = buildRowsFromSnapshot(snap, newComments, prevComments);
  renderOverview(rows);
})();

function latestLogText(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  const i = arr[0]; // most recent row (Corrigo grid is desc by Date)
  const parts = [i.ActionDateTime, i.ActionBy, i.ActionTitle, i.Comment].filter(Boolean);
  return parts.join(' — ');
}

function parseDateLoose(s) {
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function getPickupDate(arr) {
  if (!Array.isArray(arr) || !arr.length) return '-';

  let minTime = Infinity;
  let earliestStr = null;

  for (const i of arr) {
    const title = (i.ActionTitle || '').toLowerCase();
    if (!title.includes('picked up')) continue;

    const d = parseDateLoose(i.ActionDateTime);
    if (d) {
      const t = d.getTime();
      if (t < minTime) {
        minTime = t;
        // keep the original display string from the row
        earliestStr = i.ActionDateTime || '-';
      }
    }
  }
  return earliestStr || '-';
}
function buildRowsFromDiff(diffRows, newComments) {
  return diffRows.map(r => {
    const id = String(r.ID || '').trim();

    // Prefer: uploaded CSV new comment → diff's "(new)" → diff's "(previous)"
    const combinedComment =
      (newComments[id] && newComments[id].trim()) ||
      (r['Comment / last update (new)'] || '').trim() ||
      (r['Comment / last update (previous)'] || '').trim() ||
      '';

    return {
      ID: id, 
      'WO nr': r['WO nr'] || '',
      'Due date': r['Due date'] || '',
      'Description': r['Description'] || '',
      'Comment / Last update': combinedComment,
      'Pick-up date': getPickupDate(r['Activity log']),
      'KPI exemption': r['KPI exemption'] || '',
      'KPI exemption reason': r['KPI exemption reason'] || '',
      // keep Updated for color-coding (we won't render it as a column)
      'Updated': r['Updated'] || ''
    };
  });
}
function buildRowsFromSnapshot(snap, newComments, prevComments) {
  return Object.values(snap).map(r => {
    const id = String(r.ID || '').trim();

    const fromNew  = (newComments[id] || '').trim();
    const fromPrev = (prevComments[id] || '').trim();
    const fromLog  = latestLogText(r['Activity log']);

    const comment = fromNew || fromPrev || fromLog;

    // Debug what got picked
    console.log(`[overview] WO ${id} -> new=`, fromNew, ' prev=', fromPrev, ' log=', fromLog);

    return {
      ID: id, 
      'WO nr': r['WO nr'] || '',
      'Due date': r['Due date'] || '',
      'Description': r['Description'] || '',
      'Comment / Last update': comment || '',
      'Pick-up date': getPickupDate(r['Activity log']),
      'KPI exemption': r['KPI exemption'] || '',
      'KPI exemption reason': r['KPI exemption reason'] || ''
    };
  });
}
// Fixed column widths (70% of 1920px => 1344px), sized by your cm ratios
const TOTAL_PX = 1344;
const COLS_DEF = [
  { key: 'WO nr',                    px: 300 }, // 4.46 cm
  { key: 'Due date',                 px: 300 }, // 3.53 cm
  { key: 'Description',              px: 396 }, // 11.23 cm
  { key: 'Comment / Last update',    px: 334 }, // 9.48 cm
  { key: 'Pick-up date',             px: 300 }, // 3.68 cm
  { key: 'KPI exemption',            px: 101 }, // 2.86 cm
  { key: 'KPI exemption reason',     px: 101 }  // 2.86 cm
];

function renderOverview(rows) {
  // sort + color: overdue → soon → future (unless Completed/Cancelled)
  const today = new Date(); today.setHours(0,0,0,0);
  const soon  = new Date(today); soon.setDate(soon.getDate() + 7);

  rows.sort((a,b) => new Date(a['Due date']) - new Date(b['Due date']));

  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;font:12px/1.4 Calibri,"Segoe UI",sans-serif';
  table.style.width = TOTAL_PX + 'px';
  table.style.tableLayout = 'fixed';

  // ---- fixed widths via <colgroup> ----
  const colgroup = document.createElement('colgroup');
  COLS_DEF.forEach(c => {
    const col = document.createElement('col');
    col.style.width = c.px + 'px';
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);

  // ---- header ----
  const thead = table.createTHead();
  const hr = thead.insertRow();
  COLS_DEF.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c.key;
    th.style.cssText = 'border:1px solid #ccc;padding:2px 4px;background:#f5f5f5;font-weight:600;white-space:nowrap';
    hr.appendChild(th);
  });

  // ---- body ----
  const tbody = table.createTBody();
  rows.forEach(r => {
    const tr = tbody.insertRow();

    // Completed / Cancelled override due-date coloring
    const updated = (r['Updated'] || '').toLowerCase();
    if (updated.includes('cancel')) {
      tr.style.background = '#eeeeee'; // light gray
    } else if (updated.includes('completed')) {
      tr.style.background = '#ddffdd'; // light green
    } else {
  const d = new Date(r['Due date']); d.setHours(0,0,0,0);
  if (!isNaN(d)) {
    if (d < today) {
      const hasExemption = ((r['KPI exemption'] || '').trim().length > 0);
      tr.style.background = hasExemption ? '#ffdddd' : '#ffcccc'; // darker red if no exemption
    } else if (d <= soon) {
      tr.style.background = '#ffffcc';
    }
  }
}

    COLS_DEF.forEach(c => {
  const td = tr.insertCell();
  td.style.cssText = 'border:1px solid #ccc;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

  if (c.key === 'WO nr' && r.ID && r[c.key]) {
    const a = document.createElement('a');
    a.href = `https://jll-oracle.corrigo.com/corpnet/workorder/workorderdetails.aspx/${r.ID}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = r[c.key];
    a.style.cssText = 'color:#06c;text-decoration:none;border:none;font:inherit;';
    td.appendChild(a);
  } else {
    td.textContent = r[c.key] ?? '';
  }
});
  });

  document.body.innerHTML = '';
  document.body.appendChild(table);
}