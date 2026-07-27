// Toolbar popup: master switch, per-page on/off, per-page margin side, and
// shortcuts into the page's notes panel, the All-notes list, and Settings.
// All behavior lives here (MV3 CSP blocks inline JS).

/* ----------------------------------------------------------------- Theme */
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

function applyStoredTheme() {
  chrome.storage.sync.get([SETTINGS_KEY], (items) => {
    const resolved = resolveTheme(normalizeSettings(items[SETTINGS_KEY]).theme);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  });
}
applyStoredTheme();
prefersDark.addEventListener("change", applyStoredTheme);

/* ----------------------------------------------------------------- State */
const els = {
  master: document.getElementById("pp-master"),
  page: document.getElementById("pp-page"),
  pageRow: document.getElementById("pp-page-row"),
  pageSub: document.getElementById("pp-page-sub"),
  sidesRow: document.getElementById("pp-sides-row"),
  sides: document.getElementById("pp-sides"),
  open: document.getElementById("pp-open"),
  draw: document.getElementById("pp-draw"),
  all: document.getElementById("pp-all"),
  settings: document.getElementById("pp-settings"),
  toast: document.getElementById("toast")
};

let settings = { ...DEFAULT_SETTINGS };
let pages = {};
let tab = null;
let pageKey = "";
let supported = false;

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 1800);
}

function entry() {
  return pages[pageKey] || null;
}

function ensureEntry() {
  if (!pages[pageKey]) {
    pages[pageKey] = {
      url: tab.url.split("#")[0],
      title: tab.title || "",
      updatedAt: Date.now(),
      comments: []
    };
  }
  return pages[pageKey];
}

function pruneIfEmpty() {
  const e = pages[pageKey];
  if (e && (e.comments || []).length === 0 && typeof e.enabled !== "boolean") delete pages[pageKey];
}

function render() {
  els.master.checked = settings.masterEnabled;

  const e = entry();
  const count = unresolvedCount(e);
  const enabled = isPageEnabled(e, settings, tab ? tab.url : "");

  if (!supported) {
    els.pageRow.classList.add("disabled");
    els.page.disabled = true;
    els.page.checked = false;
    els.pageSub.textContent = "SideNote can't run on this page";
    els.sidesRow.classList.add("disabled");
    els.open.disabled = true;
    els.draw.disabled = true;
    return;
  }

  els.pageRow.classList.toggle("disabled", !settings.masterEnabled);
  els.page.disabled = !settings.masterEnabled;
  els.page.checked = enabled;
  const total = e ? (e.comments || []).length : 0;
  els.pageSub.textContent = total
    ? `${count} open · ${total} note${total === 1 ? "" : "s"} here`
    : "No notes yet — turn on to start";

  const sides = effectiveSides(e, settings);
  els.sides.querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.side === sides));
  });
  els.sidesRow.classList.toggle("disabled", !settings.masterEnabled);
  els.open.disabled = !enabled;
  els.draw.disabled = !settings.masterEnabled;
}

function persistPages() {
  return setPages(pages);
}

/* ----------------------------------------------------------------- Load */
async function load() {
  settings = await getSettings();
  pages = await getPages();
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = t || null;
  supported = tab && isSupportedPageUrl(tab.url);
  pageKey = supported ? pageKeyFromHref(tab.url) : "";
  render();
}

/* --------------------------------------------------------------- Wiring */
els.master.addEventListener("change", async () => {
  settings.masterEnabled = els.master.checked;
  await setSettings(settings);
  render();
});

els.page.addEventListener("change", async () => {
  const e = ensureEntry();
  e.enabled = els.page.checked;
  pruneIfEmpty();
  await persistPages();
  render();
});

els.sides.addEventListener("click", async (evt) => {
  const btn = evt.target.closest("button[data-side]");
  if (!btn || !supported) return;
  const e = ensureEntry();
  e.sides = btn.dataset.side;
  pruneIfEmpty();
  await persistPages();
  render();
});

els.open.addEventListener("click", async () => {
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "sn-open" });
    window.close();
  } catch (_) {
    toast("Reload the page, then try again.");
  }
});

els.draw.addEventListener("click", async () => {
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "sn-draw" });
    window.close();
  } catch (_) {
    toast("Reload the page, then try again.");
  }
});

els.all.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("pages.html") });
  window.close();
});

els.settings.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

load();
