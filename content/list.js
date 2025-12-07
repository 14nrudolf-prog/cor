/* global chrome */

function getListViewName() {
  try {
    const root = document.querySelectorAll('.page-actions-wrapper')[0];
    let el = root;
    if (el && el.children && el.children[0]) el = el.children[0]; else el = null;
    if (el && el.children && el.children[0]) el = el.children[0]; else el = null;
    if (el && el.children && el.children[0]) el = el.children[0]; else el = null;
    if (el && el.children && el.children[0]) el = el.children[0]; else el = null;
    const t = el && el.innerText ? el.innerText.trim() : '';
    if (t) return t;
  } catch (e) {}
  const candidates = [
    '.page-actions-wrapper h1',
    '.page-actions-wrapper .k-link',
    'h1.page-title'
  ];
  for (const sel of candidates) {
    const node = document.querySelector(sel);
    const t = node && node.textContent ? node.textContent.trim() : '';
    if (t) return t;
  }
  return '';
}

function readListData() {
  const rows = [...document.querySelectorAll('tr.k-master-row')];
  return rows.map(r => {
    const pick = s => {
      const n = r.querySelector(s);
      return (n && n.textContent ? n.textContent.trim() : '') || '';
    };
    const pickDueDate = () => {
      const td = r.querySelector('td[data-column="DueDate"]');
      if (!td) return '';
      const span = td.querySelector('span');
      return (span ? span.textContent : td.textContent).trim();
    };
    return {
      ID:                      pick('td[data-column="ID"]'),
      'WO nr':                 pick('td[data-column="Number"] a.custom-link'),
      'Due date':              pickDueDate(),
      'Description':           pick('td[data-column="Task_Refinement"]'),
      'KPI exemption':         pick('td[data-column="cf_w_1161"]'),
      'KPI exemption reason':  pick('td[data-column="cf_w_1162"]'),
      Status:                  pick('td[data-column="WOStatus"]')
    };
  });
}

if (!window.__CORRIGO_LIST_LISTENER_ADDED) {
  window.__CORRIGO_LIST_LISTENER_ADDED = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') { sendResponse({ ok: true }); return; }

  if (msg.type === 'CHECK_DAILY_OVERVIEW') {
    const name = getListViewName();
    sendResponse({ ok: name === 'Daily Overview', current: name });
    return;
  }

  if (msg.type === 'CHECK_AND_ALERT_DAILY_OVERVIEW') {
    const name = getListViewName();
    const ok = name === 'Daily Overview';
    if (!ok) alert('Please select the "Daily Overview" list view before scraping.');
    sendResponse({ ok, current: name });
    return;
  }

  if (msg.type === 'GET_LIST_DATA') {
    const listData = readListData();
    console.log('[list.js] LIST_DATA count=', listData.length);
    chrome.runtime.sendMessage({ type: 'LIST_DATA', listData });
    sendResponse({ ok: true, count: listData.length });
    return;
  }
  });
}
