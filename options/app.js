/* global chrome, WOStore */

// date helpers
function fmtDate(date) {
  if (!date) return '';
  const d = (typeof date === 'string') ? new Date(date) : date;
  if (!d || isNaN(d)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function fmtDateTimeHM(s) {
  const d = new Date(s);
  if (!d || isNaN(d)) return s || '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${mi}`; // DD.MM hh:mm
}

function needsScrapeWarning(lastScrapeAt) {
  if (!lastScrapeAt) return true;
  const d = new Date(lastScrapeAt);
  if (!d || isNaN(d)) return true;
  const today = new Date(); today.setHours(0,0,0,0);
  const last = new Date(d); last.setHours(0,0,0,0);
  return (today - last) >= 86400000; // yesterday or older
}

async function loadStore() {
  return WOStore.getStore();
}

function qs(id) { return document.getElementById(id); }

function setActiveTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tabpanel').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
}

async function refreshHeader() {
  const store = await loadStore();
  const lastEl = qs('lastScrape');
  const warnEl = qs('scrapeWarn');
  const t = store.lastScrapeAt ? new Date(store.lastScrapeAt) : null;
  lastEl.textContent = t ? `Last scrape: ${fmtDateTimeHM(t)}` : 'Never scraped';
  warnEl.hidden = !needsScrapeWarning(store.lastScrapeAt);
}

function mostRecentLogDate(wo) {
  const arr = wo.activityLog || [];
  let best = null;
  for (const i of arr) {
    const d = i.ActionDateTime && new Date(i.ActionDateTime);
    if (d && !isNaN(d) && (!best || d > best)) best = d;
  }
  return best;
}

function computeRowClasses(wo) {
  const cls = [];
  if (wo.inactive) cls.push('row-inactive');
  const lu = wo.lastUpdate && wo.lastUpdate.current;
  if (lu && lu.dateOfLastUpdate) {
    const lastUpd = new Date(lu.dateOfLastUpdate);
    const latestLog = mostRecentLogDate(wo);
    if (latestLog && lastUpd && latestLog > lastUpd) cls.push('row-needs-update');
  }
  return cls.join(' ');
}

function buildActivitySummary(wo) {
  const arr = wo.activityLog || [];
  const take = arr.slice(0, 3);
  return take.map(i => {
    const ts = fmtDateTimeHM(i.ActionDateTime || '');
    return `${i.ActionTitle || ''} - ${ts} - ${i.ActionBy || ''} - ${i.Comment || ''}`.trim();
  }).join('\n');
}

function buildLastUpdateSummary(wo) {
  const cur = wo.lastUpdate && wo.lastUpdate.current;
  if (!cur) return '';
  const ts = cur.dateOfLastUpdate ? fmtDateTimeHM(cur.dateOfLastUpdate) : '';
  const head = ts ? `${ts} - ` : '';
  return head + (cur.text || '');
}

function tdText(tr, text, cls) {
  const td = tr.insertCell();
  td.textContent = (text != null ? text : '');
  if (cls) td.className = cls;
  return td;
}

function tdPeek(tr, text, onOpen) {
  const td = tr.insertCell();
  td.className = 'cell-with-button';
  const div = document.createElement('div');
  div.className = 'cell-ellipsis';
  div.textContent = (text != null ? text : '');
  const btn = document.createElement('button');
  btn.className = 'peek-btn';
  btn.textContent = 'view';
  btn.onclick = (e) => { e.stopPropagation(); onOpen(); };
  td.appendChild(div); td.appendChild(btn);
  return td;
}

function renderWOsTable(store) {
  const tbl = qs('wosTable');
  tbl.innerHTML = '';
  const thead = tbl.createTHead();
  const hr = thead.insertRow();
  ['WO nr','Due date','Description','Last activity','Last update','Changed date'].forEach(h => {
    const th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
  });
  const tbody = tbl.createTBody();

  const all = Object.values(store.wos || {});
  const activeCount = all.filter(w => !w.inactive).length;
  const inactiveCount = all.length - activeCount;
  const hideInactive = !!(document.getElementById('cbHideInactive') && document.getElementById('cbHideInactive').checked);
  const list = all
    .filter(w => hideInactive ? !w.inactive : true)
    .sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate));

  const countsEl = document.getElementById('woCounts');
  if (countsEl) countsEl.textContent = `Active: ${activeCount}  |  Inactive: ${inactiveCount}`;
  list.forEach(wo => {
    const tr = tbody.insertRow();
    tr.className = computeRowClasses(wo);
    tdText(tr, wo.woNumber || '');
    tdText(tr, wo.dueDate || '');
    tdText(tr, wo.description || '');
    tdPeek(tr, buildActivitySummary(wo), () => openSidebarActivity(wo));
    tdPeek(tr, buildLastUpdateSummary(wo), () => openSidebarLastUpdate(wo));
    const changed = wo.lastUpdate && wo.lastUpdate.current && wo.lastUpdate.current.changedAt;
    tdText(tr, changed ? fmtDateTimeHM(new Date(changed)) : '');
  });
}

function openSidebar() {
  document.querySelector('.mainarea').classList.add('with-sidebar');
  const sb = document.getElementById('sidebar');
  sb.classList.remove('collapsed');
}
function closeSidebar() {
  document.querySelector('.mainarea').classList.remove('with-sidebar');
  const sb = document.getElementById('sidebar');
  sb.classList.add('collapsed');
}

async function openSidebarActivity(wo) {
  openSidebar();
  const host = document.getElementById('sidebarInner');
  host.innerHTML = '';

  const h = document.createElement('div');
  h.className = 'section-h'; h.textContent = `Activity log — WO ${wo.woNumber}`;
  host.appendChild(h);

  const controls = document.createElement('div'); controls.className='controls';
  const btnApply = document.createElement('button'); btnApply.className='primary'; btnApply.textContent = 'Change last update';
  controls.appendChild(btnApply);
  host.appendChild(controls);

  const list = document.createElement('div');
  (wo.activityLog || []).forEach((it, idx) => {
    const card = document.createElement('div'); card.className = 'log-item';
    const head = document.createElement('div'); head.className='log-head';
    const left = document.createElement('div');
    const title = document.createElement('div'); title.className='log-title'; title.textContent = it.ActionTitle || '';
    const meta = document.createElement('div'); meta.className='log-meta'; meta.textContent = `${fmtDateTimeHM(it.ActionDateTime || '')} — ${it.ActionBy || ''}`;
    left.appendChild(title); left.appendChild(meta);
    const right = document.createElement('div');
    const cb = document.createElement('input'); cb.type='checkbox'; cb.dataset.key = it._key || String(idx);
    right.appendChild(cb);
    head.appendChild(left); head.appendChild(right);
    const body = document.createElement('div'); body.className='log-text'; body.textContent = it.Comment || '';
    card.appendChild(head); card.appendChild(body);
    list.appendChild(card);
  });
  host.appendChild(list);

  btnApply.onclick = async () => {
    const keys = [...list.querySelectorAll('input[type="checkbox"]:checked')].map(x => x.dataset.key);
    const resp = await WOStore.changeLastUpdateFromSelection(wo.id, keys);
    if (!resp.ok) { alert(resp.error || 'Failed'); return; }
    const store = await loadStore();
    renderWOsTable(store);
    openSidebarLastUpdate(store.wos[wo.id]);
  };
}

async function openSidebarLastUpdate(wo) {
  openSidebar();
  const host = document.getElementById('sidebarInner');
  host.innerHTML = '';

  const h = document.createElement('div');
  h.className = 'section-h'; h.textContent = `Last update — WO ${wo.woNumber}`;
  host.appendChild(h);

  const lu = wo.lastUpdate || {};
  const cur = lu.current || { text:'', actionBy:'', dateOfLastUpdate:'' };

  const meta = document.createElement('div'); meta.className='muted';
  meta.textContent = cur.changedAt ? `Last changed: ${fmtDateTimeHM(new Date(cur.changedAt))}` : 'Not set';
  host.appendChild(meta);

  // Author dropdown (single line) above textarea
  const sel = document.createElement('select');
  sel.className = 'one-line';
  const authors = Array.from(new Set((wo.activityLog || []).map(function(i){ return i.ActionBy || ''; }).filter(Boolean))).sort();
  var blankOpt = document.createElement('option'); blankOpt.value = ''; blankOpt.textContent = '(author)'; sel.appendChild(blankOpt);
  authors.forEach(function(a){ var o=document.createElement('option'); o.value=a; o.textContent=a; sel.appendChild(o); });
  sel.value = cur.actionBy || '';
  host.appendChild(sel);

  // Date above textarea
  const dateLbl = document.createElement('label'); dateLbl.textContent = 'Date of last update'; dateLbl.className='muted';
  const dateIn = document.createElement('input'); dateIn.type='text'; dateIn.className='date-field'; dateIn.placeholder='MM/DD/YYYY hh:mm AM/PM';
  dateIn.value = cur.dateOfLastUpdate || '';
  host.appendChild(dateLbl);
  host.appendChild(dateIn);
  const ta = document.createElement('textarea'); ta.value = cur.text || '';
  host.appendChild(ta);

  const btns = document.createElement('div'); btns.className='controls';
  const btnSave = document.createElement('button'); btnSave.textContent='Save'; btnSave.className='primary';
  const btnNew  = document.createElement('button'); btnNew.textContent='New item';
  btns.appendChild(btnSave); btns.appendChild(btnNew);
  host.appendChild(btns);

  btnSave.onclick = async () => {
    const resp = await WOStore.saveLastUpdateEdit(wo.id, { text: ta.value, actionBy: sel.value, createNew: false, dateOfLastUpdate: dateIn.value });
    if (!resp.ok) { alert(resp.error||'Failed'); return; }
    renderWOsTable(await loadStore());
    openSidebarLastUpdate((await loadStore()).wos[wo.id]);
  };
  btnNew.onclick = async () => {
    const resp = await WOStore.saveLastUpdateEdit(wo.id, { text: ta.value, actionBy: sel.value, createNew: true, dateOfLastUpdate: dateIn.value });
    if (!resp.ok) { alert(resp.error||'Failed'); return; }
    renderWOsTable(await loadStore());
    openSidebarLastUpdate((await loadStore()).wos[wo.id]);
  };

  const histH = document.createElement('div'); histH.className='section-h'; histH.textContent='Version history';
  host.appendChild(histH);
  const hist = document.createElement('div');
  (lu.history||[]).forEach(item => {
    const card = document.createElement('div'); card.className='log-item';
    const head = document.createElement('div'); head.className='log-head';
    const title = document.createElement('div'); title.className='log-title'; title.textContent = item.actionBy || '';
    const meta = document.createElement('div'); meta.className='log-meta'; meta.textContent = `Changed: ${fmtDateTimeHM(new Date(item.changedAt))}`;
    head.appendChild(title); head.appendChild(meta);
    const body = document.createElement('div'); body.className='log-text'; body.textContent = item.text || '';
    card.appendChild(head); card.appendChild(body); hist.appendChild(card);
  });
  host.appendChild(hist);
}

async function refreshWOs() {
  const store = await loadStore();
  await refreshHeader();
  renderWOsTable(store);
}

async function startScrape() {
  // Ask SW to perform the scrape-to-store orchestration.
  await chrome.runtime.sendMessage({ type: 'SCRAPE_TO_STORE' });
  // Give it a little time; options cannot know progress exactly; refresh after short delay
  setTimeout(refreshWOs, 1500);
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(b => {
    b.onclick = () => setActiveTab(b.dataset.tab);
  });
}

function initSidebarToggle() {
  const t = document.getElementById('sidebarToggle');
  t.onclick = () => {
    const main = document.querySelector('.mainarea');
    if (main.classList.contains('with-sidebar')) closeSidebar(); else openSidebar();
  };
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSidebarToggle();
  qs('btnScrape').onclick = startScrape;
  qs('btnRefresh').onclick = refreshWOs;
  const cbHide = document.getElementById('cbHideInactive');
  if (cbHide) {
    cbHide.addEventListener('change', async () => {
      renderWOsTable(await loadStore());
    });
  }

  // Darkness slider for overview iframe
  const frame = document.getElementById('overviewFrame');
  const slider = document.getElementById('darknessSlider');
  const valEl = document.getElementById('darknessValue');
  const asOfCb = document.getElementById('cbAsOfTomorrow');
  function updateOverviewAsOf() {
    if (!frame) return;
    try {
      const url = new URL(frame.src);
      if (asOfCb && asOfCb.checked) url.searchParams.set('asOf', 'tomorrow');
      else url.searchParams.delete('asOf');
      const next = url.toString();
      if (next !== frame.src) frame.src = next;
    } catch (e) {
      // Fallback: rebuild from relative path
      const base = '../overview.html' + ((asOfCb && asOfCb.checked) ? '?asOf=tomorrow' : '');
      frame.src = base;
    }
  }
  function applyBrightness(pct) {
    if (frame) frame.style.filter = `brightness(${pct}%)`;
    if (valEl) valEl.textContent = `${pct}%`;
  }
  if (slider) {
    // default 50%
    const def = Number(slider.value || 50) || 50;
    applyBrightness(def);
    slider.addEventListener('input', () => applyBrightness(Number(slider.value || 0)));
  }
  if (asOfCb) {
    asOfCb.addEventListener('change', updateOverviewAsOf);
    // ensure initial state reflected in frame URL
    updateOverviewAsOf();
  }
  chrome.runtime.onMessage.addListener(function(msg){
    if (msg && msg.type === 'STORE_UPDATED') refreshWOs();
  });
  refreshWOs();
});
