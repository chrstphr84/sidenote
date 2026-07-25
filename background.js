// Background service worker: seeds default settings and keeps the toolbar icon
// badge showing the number of unresolved notes on the active tab's page.

importScripts("shared.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get([SETTINGS_KEY], (items) => {
    if (!items[SETTINGS_KEY]) {
      chrome.storage.sync.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
    }
  });
});

async function updateBadge(tabId, url) {
  if (!tabId || !url) return;
  try {
    const pages = await getPages();
    const entry = pages[pageKeyFromHref(url)];
    const count = unresolvedCount(entry);
    await chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: ACCENT });
  } catch (_) {
    // Tab closed or a page we can't touch (e.g. chrome://) — nothing to badge.
  }
}

async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) updateBadge(tab.id, tab.url);
  } catch (_) {
    /* no active tab */
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadge(tabId, tab.url);
  } catch (_) {
    /* gone */
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" || info.url) updateBadge(tabId, tab.url);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[PAGES_KEY]) refreshActiveTab();
});

// Content script asks the worker to open an extension page in its own tab
// (the All-notes list and Settings, from the on-page margin footer).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "sn-open-tab" && typeof msg.page === "string") {
    chrome.tabs.create({ url: chrome.runtime.getURL(msg.page) });
  }
});

refreshActiveTab();
