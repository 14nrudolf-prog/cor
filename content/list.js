/* global chrome */
console.log(1)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
console.log(2)
  if (msg.type === 'PING') { sendResponse({ ok: true }); return; }
  let listData = "abc"
  if (msg.type === 'GET_LIST_DATA') {

  const rows = [...document.querySelectorAll('tr.k-master-row')];

  listData = rows.map(r => {
    const pick = s => r.querySelector(s)?.textContent.trim() || '';

    // robust due-date getter: span (overdue) OR direct TD text (non-overdue)
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

  console.log('[list.js] LIST_DATA →', listData);
  chrome.runtime.sendMessage({ type: 'LIST_DATA', listData });
    sendResponse({ ok: true }); // ACK so SW knows a receiver exists
});
