chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch {}
  try {
    await chrome.runtime.sendMessage({ type: "lg:activate", tabId: tab.id });
  } catch {}
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});
