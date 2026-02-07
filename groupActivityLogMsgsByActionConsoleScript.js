(async () => {
  const { wo_store } = await chrome.storage.local.get('wo_store');
  const wos = (wo_store && wo_store.wos) ? Object.values(wo_store.wos) : [];
  const grouped = {};
  for (const wo of wos) {
    const log = wo.activityLog || [];
    for (const item of log) {
      const action = String(item.ActionTitle || '').trim() || '(no action)';
      const msg = String(item.Comment || '').trim();
      if (!grouped[action]) grouped[action] = [];
      grouped[action].push(msg);
    }
  }
  console.log(grouped);
})();