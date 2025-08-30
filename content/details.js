/* global chrome */

// -------- helpers: activity log pager ----------
function getActivityPagerText() {
  const root = document.querySelector('[data-role="woactivityloggrid"]');
  if (!root) return null;

  // preferred Kendo selectors
  let el = root.querySelector('.k-pager-info');
  if (el && el.textContent) return el.textContent.trim();

  // fallback to your original DOM path
  try {
    const t = root.children?.[1]?.children?.[1]?.children?.[3]?.textContent?.trim();
    if (t) return t;
  } catch (_) {}

  return null;
}

function parsePagerInfo(txt) {
  if (!txt) return null;
  const m = txt.match(/(\d+)\s*-\s*(\d+)\s*of\s*(\d+)/i);
  if (!m) return null;
  return { from: +m[1], to: +m[2], total: +m[3] };
}

function isPagerFullyExpanded(txt) {
  const info = parsePagerInfo(txt);
  // if we can't parse or no pager exists, assume fully visible
  if (!info) return true;
  return info.from === 1 && info.to === info.total;
}

// ---- config (tweak while testing) ----
const INTERVAL_MS = 300;     // poll every 300 ms
const MAX_WAIT_MS = 36000000;   // give it up to 20s to populate

window.addEventListener('load', () => {
  waitAndExtract();
});

function getIdFromUrl() {
  const parts = new URL(location.href).pathname.split('/');
  return parts[parts.length - 1] || '';
}

// ----- STATUS -----
function readStatus() {
  // Try label-based pair first: .lv-pair -> .lv-label === "Status" -> .lv-value span
  let status = '';
  const pairs = document.querySelectorAll('.lv-pair');
  for (const p of pairs) {
    const label = p.querySelector('.lv-label')?.textContent.trim();
    if (label === 'Status') {
      status = p.querySelector('.lv-value span')?.textContent.trim() || '';
      break;
    }
  }
  // Fallback to generic class seen on Corrigo
  if (!status) {
    status = document.querySelector('.lv-value span.lv-value-types-enhanced')?.textContent.trim() || '';
  }
  return { value: status, loaded: !!status };
}

// ----- ACTIVITY LOG (array of objects) -----
// ----- ACTIVITY LOG (array of objects) -----
function readActivityLog() {
  const gridRoot = document.querySelector('[data-role="woactivityloggrid"]');
  const table = gridRoot?.querySelector('table');
  if (!table) return { rows: [], loaded: false, pagerText: null, fullyExpanded: true };

  const tb = table.querySelector('tbody');
  if (!tb) return { rows: [], loaded: false, pagerText: null, fullyExpanded: true };

  const trs = [...tb.querySelectorAll('tr')];
  if (!trs.length) return { rows: [], loaded: false, pagerText: null, fullyExpanded: true };

  // "No Records Found" row?
  if (trs.length === 1 && trs[0].querySelector('td')?.getAttribute('colspan')) {
    const txt = trs[0].textContent.trim();
    if (/No Records Found/i.test(txt)) {
      const pagerText = getActivityPagerText();
      return { rows: [], loaded: true, pagerText, fullyExpanded: true };
    }
  }

  const headers = [...table.querySelectorAll('thead th')].map(th =>
    th.dataset.field || th.textContent.trim()
  );

  const rows = trs.map(tr => {
    const cells = [...tr.querySelectorAll('td')];
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i]?.textContent.trim() || '';
    });
    return obj;
  });

  const pagerText = getActivityPagerText();
  const fullyExpanded = isPagerFullyExpanded(pagerText);

  // only report loaded=true when fully expanded (e.g., "1 - 35 of 35")
  return { rows, loaded: fullyExpanded, pagerText, fullyExpanded };
}

// ----- PROCEDURES PROGRESS (Steps “X of Y” -> “X/Y”) -----
function readProceduresProgress() {
  const table = document.querySelector('[data-role="woproceduregrid"] table');
  if (!table) return { value: '', loaded: false };

  const thead = table.querySelector('thead');
  const tb = table.querySelector('tbody');
  if (!thead || !tb) return { value: '', loaded: false };

  const headers = [...thead.querySelectorAll('th')].map(th =>
    th.dataset.field || th.textContent.trim()
  );
  const stepsIdx = headers.findIndex(h => h.toLowerCase() === 'steps');
  const trs = [...tb.querySelectorAll('tr')];

  if (!trs.length) return { value: '', loaded: false };

  // "No Records Found"
  if (trs.length === 1 && trs[0].querySelector('td')?.getAttribute('colspan')) {
    const txt = trs[0].textContent.trim();
    if (/No Records Found/i.test(txt)) return { value: '', loaded: true };
  }

  if (stepsIdx < 0) return { value: '', loaded: false };

  // Take first data row with enough cells
  const dataTr = trs.find(tr => tr.querySelectorAll('td').length > stepsIdx);
  if (!dataTr) return { value: '', loaded: false };

  const raw = dataTr.querySelectorAll('td')[stepsIdx]?.textContent.trim() || '';
  const m = raw.match(/(\d+)\s*of\s*(\d+)/i);
  if (m) {
    return { value: `${m[1]}/${m[2]}`, loaded: true };
  }
  // If we see the column but it hasn't populated text yet, keep waiting
  return { value: '', loaded: false };
}

// ----- POLL UNTIL READY -----
function waitAndExtract() {
  const ID = getIdFromUrl();
  const start = Date.now();
  let attempts = 0;

  const timer = setInterval(() => {
    attempts++;

    const status = readStatus();
    const act = readActivityLog();
    const proc = readProceduresProgress();

console.log(
  `[details] attempt #${attempts} (+${Date.now() - start}ms):`,
  {
    ID,
    status: status.value, statusLoaded: status.loaded,
    activityRows: act.rows.length, activityLoaded: act.loaded,
    activityPager: act.pagerText || '(none)',
    procedures: proc.value, proceduresLoaded: proc.loaded
  }
);

    const allLoaded = status.loaded && act.loaded && proc.loaded;

    if (allLoaded) {
      clearInterval(timer);
      const payload = {
        ID,
        Status: status.value,
        'Activity log': act.rows,
        'Procedures progress': proc.value
      };
      console.log('[details] ✅ extracted (final):', payload);
      chrome.runtime.sendMessage({ type: 'DETAILS_DATA', data: payload });
    } else if (Date.now() - start > MAX_WAIT_MS) {
      clearInterval(timer);
      const payload = {
        ID,
        Status: status.value || '',
        'Activity log': act.rows || [],
        'Procedures progress': proc.value || '',
        _debug: {
          statusLoaded: status.loaded,
          activityLoaded: act.loaded,
          proceduresLoaded: proc.loaded,
          timedOutMs: Date.now() - start
        }
      };
      console.warn('[details] ⚠️ timeout; sending partial:', payload);
      chrome.runtime.sendMessage({ type: 'DETAILS_DATA', data: payload });
    }
  }, INTERVAL_MS);
}
