// Background service worker: seeds default settings and keeps the toolbar icon
// badge showing the number of unresolved notes on the active tab's page.

importScripts("shared.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get([SETTINGS_KEY], (items) => {
    if (!items[SETTINGS_KEY]) {
      chrome.storage.sync.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
    }
  });
  refreshMenus();
});

if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(refreshMenus);

/* ------------------------------------------------------- Context menus */
// Rebuilt whenever the setting changes so the items appear/disappear silently.
function refreshMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError; // ignore "no menus" on first run
    getSettings().then((s) => {
      if (!s.addContextMenu) return;
      chrome.contextMenus.create({
        id: "sn-add-selection",
        title: "Add SideNote to selection",
        contexts: ["selection"]
      });
      chrome.contextMenus.create({
        id: "sn-add-element",
        title: "Link SideNote to this element",
        contexts: ["image", "link", "video", "audio", "page"]
      });
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  const type =
    info.menuItemId === "sn-add-selection"
      ? "sn-add-selection"
      : info.menuItemId === "sn-add-element"
      ? "sn-add-element"
      : null;
  if (type) chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
});

/* -------------------------------------------------------- Keyboard cmd */
if (chrome.commands) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "add-note") return;
    const s = await getSettings();
    if (!s.shortcutEnabled) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: "sn-add-selection" }).catch(() => {});
    } catch (_) {
      /* no active tab */
    }
  });
}

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
  if (area === "sync" && changes[SETTINGS_KEY]) refreshMenus();
});

// Content script asks the worker to open an extension page in its own tab
// (the All-notes list and Settings, from the on-page margin footer). The
// DevTools sidebar relays link requests to the inspected tab's content script.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "sn-open-tab" && typeof msg.page === "string") {
    chrome.tabs.create({ url: chrome.runtime.getURL(msg.page) });
  } else if (msg.type === "sn-devtools-link" && msg.tabId) {
    chrome.tabs.sendMessage(msg.tabId, { type: "sn-devtools-link" }).catch(() => {});
  }
});

refreshActiveTab();
