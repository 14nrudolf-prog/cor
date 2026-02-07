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
const HIGHLIGHT_ACTIONS = new Set([
  'note',
  'message received',
  'message sent',
  'picked up',
  'wo item added/deleted',
  'stopped',
  'started',
  'flagged',
  're-opened',
  'vendor invoice status change',
  'completed',
  'flag cleared'
]);
const NEVER_HIGHLIGHT_ACTIONS = new Set([
  'sent to service pro',
  'document attached',
  'created',
  'assignment changed',
  'acknowledge by modified',
  'on site by modified',
  'due by modified',
  'priority modified'
]);
const HIGHLIGHT_RULES_STORAGE_KEY = 'activityHighlightRules';
const AUTHOR_COLOR_VARIANTS = [
  'hsl(195, 90%, 85%)',    // cyan light
  'hsl(30, 100%, 85%)',    // orange light
  'hsl(280, 80%, 85%)',    // purple light
  'hsl(60, 100%, 90%)',    // yellow light
  'hsl(140, 60%, 85%)',    // green light
  'hsl(195, 90%, 40%)',    // cyan dark
  'hsl(30, 100%, 45%)',    // orange dark
  'hsl(280, 80%, 45%)',    // purple dark
  'hsl(60, 100%, 55%)',    // yellow dark
  'hsl(140, 60%, 40%)'     // green dark
];
let lastViewedWoId = null;
let authorColorState = null;
let highlightRules = { always: new Set(), never: new Set() };

async function ensureAuthorColorState() {
  if (authorColorState) return;
  const data = await chrome.storage.local.get('activityAuthorColorState');
  authorColorState = data.activityAuthorColorState || { map: {}, nextIndex: 0 };
  if (normalizeAuthorColors()) persistAuthorColorState();
}

async function ensureHighlightRules() {
  if (highlightRules && highlightRules._loaded) return;
  const data = await chrome.storage.local.get(HIGHLIGHT_RULES_STORAGE_KEY);
  const raw = data[HIGHLIGHT_RULES_STORAGE_KEY] || { always: [], never: [] };
  highlightRules = {
    always: new Set((raw.always || []).map(s => String(s).trim().toLowerCase()).filter(Boolean)),
    never: new Set((raw.never || []).map(s => String(s).trim().toLowerCase()).filter(Boolean)),
    _loaded: true
  };
}

function persistHighlightRules() {
  const payload = {
    always: Array.from(highlightRules.always || []),
    never: Array.from(highlightRules.never || [])
  };
  chrome.storage.local.set({ [HIGHLIGHT_RULES_STORAGE_KEY]: payload });
}

function persistAuthorColorState() {
  if (!authorColorState) return;
  chrome.storage.local.set({ activityAuthorColorState: authorColorState });
}

function getUpdatedAuthorColor(author) {
  if (!author) return null;
  if (!authorColorState) return null;
  let info = authorColorState.map[author];
  if (info && info.color && isRedHue(info.color)) {
    info.color = pickStableAuthorColor(author);
    persistAuthorColorState();
  }
  if (!info) {
    const idx = authorColorState.nextIndex % AUTHOR_COLOR_VARIANTS.length;
    info = { color: AUTHOR_COLOR_VARIANTS[idx] };
    authorColorState.map[author] = info;
    authorColorState.nextIndex = (authorColorState.nextIndex + 1) % AUTHOR_COLOR_VARIANTS.length;
    persistAuthorColorState();
  }
  return info.color;
}

function getContrastTextColor(color) {
  if (!color) return '#000';
  const m = color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/i);
  if (!m) return '#000';
  const lightness = Number(m[3]);
  return lightness >= 55 ? '#000' : '#fff';
}

function hashString(value) {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) - h) + value.charCodeAt(i);
    h |= 0;
  }
  return h;
}

function pickStableAuthorColor(author) {
  const idx = Math.abs(hashString(author || '')) % AUTHOR_COLOR_VARIANTS.length;
  return AUTHOR_COLOR_VARIANTS[idx];
}

function isRedHue(color) {
  const m = color && color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/i);
  if (!m) return false;
  const hue = Number(m[1]);
  const sat = Number(m[2]);
  if (isNaN(hue) || isNaN(sat)) return false;
  const normalizedHue = ((hue % 360) + 360) % 360;
  return sat >= 50 && (normalizedHue <= 15 || normalizedHue >= 345);
}

function normalizeAuthorColors() {
  if (!authorColorState || !authorColorState.map) return false;
  let changed = false;
  Object.keys(authorColorState.map).forEach(author => {
    const info = authorColorState.map[author];
    if (!info || !info.color) return;
    if (isRedHue(info.color)) {
      info.color = pickStableAuthorColor(author);
      changed = true;
    }
  });
  return changed;
}

function parseDateLoose(s) {
  const d = new Date(s || '');
  return isNaN(d) ? null : d;
}

function getHighlightKind(actionTitle, commentText) {
  const normalizedAction = (actionTitle || '').trim().toLowerCase();
  const hasComment = ((commentText || '').trim().length > 0);
  if (!hasComment) return null;
  if (highlightRules.always && highlightRules.always.has(normalizedAction)) return 'always';
  if (highlightRules.never && highlightRules.never.has(normalizedAction)) return null;
  if (NEVER_HIGHLIGHT_ACTIONS.has(normalizedAction)) return null;
  if (HIGHLIGHT_ACTIONS.has(normalizedAction)) return 'always';
  return 'unknown';
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
  anchor.className = 'wo-link';
  td.appendChild(anchor);
  return td;
}

function tdClickable(tr, text, onOpen) {
  const td = tr.insertCell();
  td.className = 'cell-clickable';
  td.tabIndex = 0;
  td.setAttribute('role', 'button');
  const div = document.createElement('div');
  div.className = 'cell-ellipsis';
  div.textContent = (text != null ? text : '');
  const handler = (e) => {
    e.stopPropagation();
    onOpen();
  };
  td.addEventListener('click', handler);
  td.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler(e);
    }
  });
  td.appendChild(div);
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
    tdClickable(tr, buildActivitySummary(wo), () => openSidebarActivity(wo));
    tdClickable(tr, buildLastUpdateSummary(wo), () => openSidebarLastUpdate(wo));
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
  await ensureAuthorColorState();
  await ensureHighlightRules();
  const currentUpdateKeys = new Set(
    ((wo.lastUpdate && wo.lastUpdate.current && wo.lastUpdate.current.selectedLogKeys) || [])
      .map(String)
  );

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
    const key = it._key || String(idx);
    const isCurrentUpdate = currentUpdateKeys.has(String(key));
    const highlightKind = getHighlightKind(it.ActionTitle, it.Comment);
    if (highlightKind === 'always') card.classList.add('log-item-highlighted');
    if (highlightKind === 'unknown') card.classList.add('log-item-highlight-unknown');
    if (isCurrentUpdate) card.classList.add('log-item-current-update');
    const head = document.createElement('div'); head.className='log-head';
    const left = document.createElement('div');
    const titleRow = document.createElement('div'); titleRow.className='log-title-row';
    const title = document.createElement('div'); title.className='log-title'; title.textContent = it.ActionTitle || '';
    titleRow.appendChild(title);
    if (isCurrentUpdate) {
      const currentChip = document.createElement('span');
      currentChip.className = 'author-chip current-update-chip';
      currentChip.textContent = 'current last update';
      titleRow.appendChild(currentChip);
    }
    const meta = document.createElement('div'); meta.className='log-meta muted';
    const dateSpan = document.createElement('span'); dateSpan.className='log-meta-date';
    dateSpan.textContent = fmtDateTimeHM(it.ActionDateTime || '');
    if (highlightKind === 'always') dateSpan.classList.add('log-meta-date-highlighted');
    if (highlightKind === 'unknown') dateSpan.classList.add('log-meta-date-highlight-unknown');
    meta.appendChild(dateSpan);
    const authorName = (it.ActionBy || '').trim();
    if (authorName) {
      const authorChip = document.createElement('span'); authorChip.className='author-chip';
      const color = getUpdatedAuthorColor(authorName);
      if (color) {
        authorChip.style.backgroundColor = color;
        authorChip.style.color = getContrastTextColor(color);
      }
      authorChip.textContent = authorName;
      meta.appendChild(authorChip);
    }
    left.appendChild(titleRow); left.appendChild(meta);
    const right = document.createElement('div');
    const cb = document.createElement('input'); cb.type='checkbox'; cb.dataset.key = key;
    right.appendChild(cb);
    head.appendChild(left); head.appendChild(right);
    const body = document.createElement('div'); body.className='log-text'; body.textContent = it.Comment || '';
    card.appendChild(head); card.appendChild(body);
    card.classList.add('log-item-selectable');
    card.classList.add('selectable');
    const syncSelection = () => card.classList.toggle('selected', cb.checked);
    cb.addEventListener('change', syncSelection);
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      syncSelection();
    });
    list.appendChild(card);
    requestAnimationFrame(() => {
      const qualifiesForToggle = card.scrollHeight > 300;
      if (!qualifiesForToggle) return;
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
  await ensureAuthorColorState();
  await ensureHighlightRules();
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
  initSettingsModal();
  refreshWOs();
});

function normalizeActionKey(actionTitle) {
  return String(actionTitle || '').trim().toLowerCase();
}

function buildActionMapFromStore(store) {
  const items = [];
  Object.values(store.wos || {}).forEach(wo => {
    const log = wo.activityLog || [];
    log.forEach(it => {
      const actionKey = normalizeActionKey(it.ActionTitle);
      items.push({
        actionKey,
        actionTitle: it.ActionTitle || '',
        comment: it.Comment || '',
        actionBy: it.ActionBy || '',
        actionDateTime: it.ActionDateTime || '',
        woNumber: wo.woNumber || '',
        woId: wo.id || ''
      });
    });
  });
  const map = {};
  items.forEach(item => {
    if (!map[item.actionKey]) {
      map[item.actionKey] = { label: item.actionTitle || item.actionKey || '(no action)', items: [] };
    }
    map[item.actionKey].items.push(item);
  });
  return map;
}

function renderLogItemFromData(item, opts) {
  const card = document.createElement('div'); card.className = 'log-item';
  if (opts && opts.selectable) {
    card.classList.add('log-item-selectable');
    card.classList.add('selectable');
  }
  const head = document.createElement('div'); head.className = 'log-head';
  const left = document.createElement('div');
  const titleRow = document.createElement('div'); titleRow.className = 'log-title-row';
  const title = document.createElement('div'); title.className = 'log-title'; title.textContent = item.actionTitle || '';
  titleRow.appendChild(title);
  left.appendChild(titleRow);
  const meta = document.createElement('div'); meta.className = 'log-meta muted';
  const dateSpan = document.createElement('span'); dateSpan.className = 'log-meta-date';
  dateSpan.textContent = fmtDateTimeHM(item.actionDateTime || '');
  meta.appendChild(dateSpan);
  if (item.actionBy) {
    const authorChip = document.createElement('span'); authorChip.className = 'author-chip';
    const color = getUpdatedAuthorColor(item.actionBy);
    if (color) {
      authorChip.style.backgroundColor = color;
      authorChip.style.color = getContrastTextColor(color);
    }
    authorChip.textContent = item.actionBy;
    meta.appendChild(authorChip);
  }
  if (item.woNumber) {
    const woChip = document.createElement('span'); woChip.className = 'author-chip';
    woChip.textContent = `WO ${item.woNumber}`;
    meta.appendChild(woChip);
  }
  left.appendChild(meta);
  const right = document.createElement('div');
  let cb = null;
  if (opts && opts.selectable) {
    cb = document.createElement('input'); cb.type = 'checkbox';
    cb.dataset.actionKey = item.actionKey || '';
    right.appendChild(cb);
  }
  head.appendChild(left); head.appendChild(right);
  const body = document.createElement('div'); body.className = 'log-text'; body.textContent = item.comment || '';
  card.appendChild(head); card.appendChild(body);
  if (cb) {
    const syncSelection = () => card.classList.toggle('selected', cb.checked);
    cb.addEventListener('change', syncSelection);
    card.addEventListener('click', (e) => {
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      syncSelection();
    });
  }
  return card;
}

function renderPendingTab(host, actionMap, pendingKeys) {
  host.innerHTML = '';
  if (!pendingKeys.length) {
    const empty = document.createElement('div'); empty.className = 'modal-empty';
    empty.textContent = 'No pending actions.';
    host.appendChild(empty);
    return;
  }
  pendingKeys.forEach(key => {
    const group = actionMap[key];
    if (!group) return;
    const title = document.createElement('div'); title.className = 'modal-section-title';
    title.textContent = group.label || key;
    host.appendChild(title);
    group.items.forEach(item => {
      host.appendChild(renderLogItemFromData(item, { selectable: true }));
    });
  });
}

function renderActionTab(host, actionMap, actionKeys, selectedKey, onSelect) {
  host.innerHTML = '';
  const keys = actionKeys.slice().sort();
  if (!keys.length) {
    const empty = document.createElement('div'); empty.className = 'modal-empty';
    empty.textContent = 'No actions.';
    host.appendChild(empty);
    return;
  }
  const list = document.createElement('div'); list.className = 'action-list';
  const itemsHost = document.createElement('div');
  let activeKey = (selectedKey && keys.includes(selectedKey)) ? selectedKey : keys[0];
  const renderItems = (key) => {
    itemsHost.innerHTML = '';
    const group = actionMap[key];
    if (!group || !group.items || !group.items.length) {
      const empty = document.createElement('div'); empty.className = 'modal-empty';
      empty.textContent = 'No items for this action yet.';
      itemsHost.appendChild(empty);
      return;
    }
    group.items.forEach(item => itemsHost.appendChild(renderLogItemFromData(item)));
  };
  keys.forEach(key => {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'action-chip';
    chip.textContent = (actionMap[key] && actionMap[key].label) ? actionMap[key].label : key;
    chip.classList.toggle('active', key === activeKey);
    chip.onclick = () => {
      activeKey = key;
      list.querySelectorAll('.action-chip').forEach(c => c.classList.toggle('active', c === chip));
      renderItems(key);
      if (typeof onSelect === 'function') onSelect(key);
    };
    list.appendChild(chip);
  });
  host.appendChild(list);
  host.appendChild(itemsHost);
  renderItems(activeKey);
  if (typeof onSelect === 'function') onSelect(activeKey);
}

function initSettingsModal() {
  const btn = document.getElementById('settingsBtn');
  const modal = document.getElementById('settingsModal');
  const closeBtn = document.getElementById('settingsClose');
  const btnSetAlways = document.getElementById('btnSetAlways');
  const btnSetNever = document.getElementById('btnSetNever');
  const btnMoveToAlways = document.getElementById('btnMoveToAlways');
  const btnMoveToNever = document.getElementById('btnMoveToNever');
  const tabButtons = Array.from(document.querySelectorAll('.modal-tab'));
  const tabPending = document.getElementById('modalTabPending');
  const tabAlways = document.getElementById('modalTabAlways');
  const tabNever = document.getElementById('modalTabNever');
  if (!btn || !modal || !closeBtn) return;

  let selectedAlwaysKey = null;
  let selectedNeverKey = null;

  const setActiveTab = (name) => {
    tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabPending.classList.toggle('active', name === 'pending');
    tabAlways.classList.toggle('active', name === 'always');
    tabNever.classList.toggle('active', name === 'never');
    const showActions = (name === 'pending');
    btnSetAlways.style.display = showActions ? '' : 'none';
    btnSetNever.style.display = showActions ? '' : 'none';
    btnMoveToAlways.hidden = name !== 'never';
    btnMoveToNever.hidden = name !== 'always';
  };

  const openModal = async () => {
    await ensureAuthorColorState();
    await ensureHighlightRules();
    const store = await loadStore();
    const actionMap = buildActionMapFromStore(store);
    const alwaysKeys = new Set([...HIGHLIGHT_ACTIONS, ...(highlightRules.always || [])]);
    const neverKeys = new Set([...NEVER_HIGHLIGHT_ACTIONS, ...(highlightRules.never || [])]);
    (highlightRules.always || []).forEach(k => neverKeys.delete(k));
    (highlightRules.never || []).forEach(k => alwaysKeys.delete(k));
    const allKeys = Object.keys(actionMap);
    const pendingKeys = allKeys.filter(k => !alwaysKeys.has(k) && !neverKeys.has(k));

    renderPendingTab(tabPending, actionMap, pendingKeys);
    renderActionTab(tabAlways, actionMap, Array.from(alwaysKeys), selectedAlwaysKey, (k) => { selectedAlwaysKey = k; });
    renderActionTab(tabNever, actionMap, Array.from(neverKeys), selectedNeverKey, (k) => { selectedNeverKey = k; });
    setActiveTab('pending');
    modal.hidden = false;
  };

  const closeModal = () => { modal.hidden = true; };

  btn.onclick = openModal;
  closeBtn.onclick = closeModal;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  tabButtons.forEach(b => b.onclick = () => setActiveTab(b.dataset.tab));

  const applySelection = async (target) => {
    await ensureHighlightRules();
    const selected = Array.from(tabPending.querySelectorAll('input[type="checkbox"]:checked'));
    const actionKeys = Array.from(new Set(selected.map(x => String(x.dataset.actionKey || '').trim()).filter(Boolean)));
    if (!actionKeys.length) return;
    actionKeys.forEach(k => {
      if (target === 'always') {
        highlightRules.never.delete(k);
        highlightRules.always.add(k);
      } else {
        highlightRules.always.delete(k);
        highlightRules.never.add(k);
      }
    });
    persistHighlightRules();
    openModal();
  };

  btnSetAlways.onclick = () => applySelection('always');
  btnSetNever.onclick = () => applySelection('never');

  const moveAction = async (from, to) => {
    await ensureHighlightRules();
    const key = (from === 'always') ? selectedAlwaysKey : selectedNeverKey;
    if (!key) return;
    if (to === 'always') {
      highlightRules.never.delete(key);
      highlightRules.always.add(key);
    } else {
      highlightRules.always.delete(key);
      highlightRules.never.add(key);
    }
    persistHighlightRules();
    openModal();
  };

  if (btnMoveToAlways) btnMoveToAlways.onclick = () => moveAction('never', 'always');
  if (btnMoveToNever) btnMoveToNever.onclick = () => moveAction('always', 'never');
}
