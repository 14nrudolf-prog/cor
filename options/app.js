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
const AS_OF_PARAM = 'nextWeekDay';
let lastViewedWoId = null;

function parseDateLoose(s) {
  const d = new Date(s || '');
  return isNaN(d) ? null : d;
}

function getLastUpdateDate(wo) {
  const cur = wo.lastUpdate && wo.lastUpdate.current;
  if (!cur) return null;
  return parseDateLoose(cur.dateOfLastUpdate);
}

function woHasNewActivitySinceLastUpdate(wo) {
  const latest = mostRecentLogDate(wo);
  if (!latest) return false;
  const lastUpd = getLastUpdateDate(wo);
  if (!lastUpd) return true;
  return latest > lastUpd;
}

function woNeedsReview(wo) {
  if (wo.activityLogReviewed) return false;
  const lastUpdate = getLastUpdateDate(wo);
  const noLastUpdate = !lastUpdate;
  return noLastUpdate || woHasNewActivitySinceLastUpdate(wo);
}

function shouldShowOnlyToBeUpdated() {
  const cb = document.getElementById('cbOnlyToUpdate');
  return cb ? cb.checked : false;
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

function mostRecentLogTime(wo) {
  const date = mostRecentLogDate(wo);
  return date ? date.getTime() : null;
}

function computeRowClasses(wo) {
  const cls = [];
  if (wo.inactive) cls.push('row-inactive');
  return cls.join(' ');
}

const HIGHLIGHT_ACTIONS = new Set(['note', 'message received', 'started']);

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

function tdLink(tr, text, href, cls) {
  const td = tr.insertCell();
  if (cls) td.className = cls;
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  anchor.textContent = (text != null ? text : '');
  anchor.style.cssText = 'color:#06c;text-decoration:none;';
  td.appendChild(anchor);
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
  const showOnlyToUpdate = shouldShowOnlyToBeUpdated();
  const rows = all
    .filter(w => hideInactive ? !w.inactive : true)
    .filter(w => showOnlyToUpdate ? woNeedsReview(w) : true)
    .sort((a,b) => {
      const timeA = mostRecentLogTime(a);
      const timeB = mostRecentLogTime(b);
      if (timeA && timeB) return timeB - timeA; // newer activities first
      if (timeA && !timeB) return -1;
      if (!timeA && timeB) return 1;
      const dueA = new Date(a.dueDate);
      const dueB = new Date(b.dueDate);
      const da = isNaN(dueA) ? Number.POSITIVE_INFINITY : dueA.getTime();
      const db = isNaN(dueB) ? Number.POSITIVE_INFINITY : dueB.getTime();
      return da - db;
    });

  const countsEl = document.getElementById('woCounts');
  if (countsEl) countsEl.textContent = `Active: ${activeCount}  |  Inactive: ${inactiveCount}`;
  rows.forEach(wo => {
    const tr = tbody.insertRow();
    const classes = [computeRowClasses(wo)];
    const needsReview = woNeedsReview(wo);
    const reviewed = !!wo.activityLogReviewed;
    const isLastViewed = wo.id === lastViewedWoId;
    if (isLastViewed) classes.push('row-last-viewed');
    else if (reviewed) classes.push('row-reviewed');
    else if (needsReview) classes.push('row-to-review');
    tr.className = classes.filter(Boolean).join(' ');
    if (wo.id) {
      tdLink(tr, wo.woNumber || '', `https://jll-oracle.corrigo.com/corpnet/workorder/workorderdetails.aspx/${wo.id}`);
    } else {
      tdText(tr, wo.woNumber || '');
    }
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
  lastViewedWoId = wo.id;
  openSidebar();
  const host = document.getElementById('sidebarInner');
  host.innerHTML = '';

  const h = document.createElement('div');
  h.className = 'section-h'; h.textContent = `Activity log — WO ${wo.woNumber}`;
  host.appendChild(h);

  const controls = document.createElement('div'); controls.className='controls';
  const btnApply = document.createElement('button'); btnApply.className='primary'; btnApply.textContent = 'Change last update';
  const btnReviewed = document.createElement('button');
  btnReviewed.textContent = wo.activityLogReviewed ? 'Reviewed' : 'Mark reviewed';
  btnReviewed.disabled = !!wo.activityLogReviewed;
  btnReviewed.onclick = async (e) => {
    e.stopPropagation();
    const resp = await WOStore.markActivityLogReviewed(wo.id, true);
    if (!resp.ok) { alert(resp.error || 'Failed'); return; }
    btnReviewed.textContent = 'Reviewed';
    btnReviewed.disabled = true;
    renderWOsTable(await loadStore());
    closeSidebar();
  };
  controls.appendChild(btnApply);
  controls.appendChild(btnReviewed);
  host.appendChild(controls);

  const list = document.createElement('div');
  (wo.activityLog || []).forEach((it, idx) => {
    const card = document.createElement('div'); card.className = 'log-item';
    const normalizedAction = (it.ActionTitle || '').trim().toLowerCase();
    if (HIGHLIGHT_ACTIONS.has(normalizedAction)) card.classList.add('log-item-highlighted');
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
    requestAnimationFrame(() => {
      if (body.scrollHeight > 100) {
        body.classList.add('log-text-truncated');
        const btnBottom = document.createElement('button');
        btnBottom.type = 'button';
        btnBottom.className = 'view-toggle view-toggle-bottom';
        btnBottom.textContent = 'view more';
        const btnTop = document.createElement('button');
        btnTop.type = 'button';
        btnTop.className = 'view-toggle view-toggle-top';
        btnTop.textContent = 'view less';
        const setExpanded = (value) => {
          card.classList.toggle('expanded', value);
          btnBottom.textContent = value ? 'view less' : 'view more';
        };
        btnBottom.addEventListener('click', () => setExpanded(!card.classList.contains('expanded')));
        btnTop.addEventListener('click', () => setExpanded(false));
        card.appendChild(btnBottom);
        card.appendChild(btnTop);
      }
    });
  });
  if (wo.activityLogTruncated) {
    const card = document.createElement('div'); card.className = 'log-item';
    const head = document.createElement('div'); head.className='log-head';
    const title = document.createElement('div'); title.className='log-title'; title.textContent = 'More activity log entries available';
    head.appendChild(title);
    const body = document.createElement('div'); body.className='log-text';
    const link = document.createElement('a');
    link.href = `https://jll-oracle.corrigo.com/corpnet/workorder/workorderdetails.aspx/${wo.id}`;
    link.target = '_blank'; link.rel = 'noopener';
    link.textContent = 'these are only the most recent activity log entries, click here to visit the WO page and see the complete activity log';
    body.appendChild(link);
    card.appendChild(head); card.appendChild(body);
    list.appendChild(card);
  }
  host.appendChild(list);

  btnApply.onclick = async () => {
    const keys = [...list.querySelectorAll('input[type="checkbox"]:checked')].map(x => x.dataset.key);
    const resp = await WOStore.changeLastUpdateFromSelection(wo.id, keys);
    if (!resp.ok) { alert(resp.error || 'Failed'); return; }
    await WOStore.markActivityLogReviewed(wo.id, true);
    const store = await loadStore();
    renderWOsTable(store);
    closeSidebar();
  };
  renderWOsTable(await loadStore());
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
  const cbOnly = document.getElementById('cbOnlyToUpdate');
  if (cbOnly) {
    cbOnly.addEventListener('change', async () => {
      renderWOsTable(await loadStore());
    });
  }
  const sidebarClose = document.getElementById('sidebarClose');
  if (sidebarClose) {
    sidebarClose.onclick = (e) => { e.preventDefault(); closeSidebar(); };
  }

  // Darkness slider for overview iframe
  function shouldAutoSelectNextWeekDay() {
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 5=Fri, 6=Sat
    const hour = now.getHours();
    if (day === 5 && hour >= 17) return true;
    if (day === 6 || day === 0) return true;
    return hour >= 17;
  }
  const frame = document.getElementById('overviewFrame');
  const slider = document.getElementById('darknessSlider');
  const valEl = document.getElementById('darknessValue');
  const asOfCb = document.getElementById('cbAsOfNextWeekDay');
  function updateOverviewAsOf() {
    if (!frame) return;
    try {
      const url = new URL(frame.src);
      if (asOfCb && asOfCb.checked) url.searchParams.set('asOf', AS_OF_PARAM);
      else url.searchParams.delete('asOf');
      const next = url.toString();
      if (next !== frame.src) frame.src = next;
    } catch (e) {
      // Fallback: rebuild from relative path
      const params = [];
      if (asOfCb && asOfCb.checked) params.push(`asOf=${AS_OF_PARAM}`);
      const base = '../overview.html' + (params.length ? `?${params.join('&')}` : '');
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
    if (shouldAutoSelectNextWeekDay()) asOfCb.checked = true;
    asOfCb.addEventListener('change', updateOverviewAsOf);
    // ensure initial state reflected in frame URL
    updateOverviewAsOf();
  }
  chrome.runtime.onMessage.addListener(function(msg){
    if (msg && msg.type === 'STORE_UPDATED') refreshWOs();
  });
  refreshWOs();
});
