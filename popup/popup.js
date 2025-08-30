/* global chrome */
document.getElementById('btnUpdate').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const daysWindow = Number(document.getElementById('daysWindow').value) || 2;
  const dropRecent  = Number(document.getElementById('dropRecent').value) || 0;

  chrome.runtime.sendMessage({
    type: 'UPDATE_REQUEST',
    tabId: tab.id,
    daysWindow,
    dropRecent
  });
};


document.getElementById('btnGenerate').onclick = () => {
  document.getElementById('csvInput').click();
};

document.getElementById('csvInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    chrome.runtime.sendMessage({ type: 'GENERATE_OVERVIEW', csvText: reader.result });
    window.close();          // popup done – let the overview open in new tab
  };
  reader.readAsText(file);
});
