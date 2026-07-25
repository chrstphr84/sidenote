// Settings page. Reads/writes the single settings object in chrome.storage.sync
// and reflects the theme live. Opens in its own tab (see options_ui in the
// manifest).

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

let settings = { ...DEFAULT_SETTINGS };

const els = {
  master: document.getElementById("master"),
  theme: document.getElementById("theme"),
  sides: document.getElementById("sides"),
  color: document.getElementById("color"),
  width: document.getElementById("width"),
  addSelection: document.getElementById("add-selection"),
  addContext: document.getElementById("add-context"),
  shortcutEnabled: document.getElementById("shortcut-enabled"),
  shortcutBtn: document.getElementById("shortcut-btn"),
  pagesSummary: document.getElementById("pages-summary"),
  openPages: document.getElementById("open-pages"),
  version: document.getElementById("ext-version"),
  toast: document.getElementById("toast")
};

function applyTheme() {
  const resolved = resolveTheme(settings.theme);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}
prefersDark.addEventListener("change", () => {
  if (settings.theme === "auto") applyTheme();
});

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 1600);
}

function markSegment(container, key, value) {
  container.querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset[key] === value));
  });
}

function render() {
  els.master.checked = settings.masterEnabled;
  markSegment(els.theme, "theme", settings.theme);
  markSegment(els.sides, "side", settings.defaultSides);
  els.color.value = settings.highlightColor;
  els.width.value = settings.marginWidth;
  els.addSelection.checked = settings.addSelectionButton;
  els.addContext.checked = settings.addContextMenu;
  els.shortcutEnabled.checked = settings.shortcutEnabled;
  applyTheme();
}

async function save() {
  await setSettings(settings);
  toast("Saved");
}

/* --------------------------------------------------------------- Wiring */
els.master.addEventListener("change", () => {
  settings.masterEnabled = els.master.checked;
  save();
});

els.theme.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-theme]");
  if (!btn) return;
  settings.theme = btn.dataset.theme;
  render();
  save();
});

els.sides.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-side]");
  if (!btn) return;
  settings.defaultSides = btn.dataset.side;
  render();
  save();
});

els.color.addEventListener("input", () => {
  settings.highlightColor = els.color.value;
});
els.color.addEventListener("change", () => {
  settings = normalizeSettings(settings);
  render();
  save();
});

els.width.addEventListener("change", () => {
  settings.marginWidth = Number(els.width.value);
  settings = normalizeSettings(settings);
  render();
  save();
});

// The selection button and right-click menu can't both be off.
function updateAddMethod(which, value) {
  if (!value && which === "addSelectionButton" && !settings.addContextMenu) {
    toast("Keep at least one add method on");
    render();
    return;
  }
  if (!value && which === "addContextMenu" && !settings.addSelectionButton) {
    toast("Keep at least one add method on");
    render();
    return;
  }
  settings[which] = value;
  render();
  save();
}

els.addSelection.addEventListener("change", () => updateAddMethod("addSelectionButton", els.addSelection.checked));
els.addContext.addEventListener("change", () => updateAddMethod("addContextMenu", els.addContext.checked));
els.shortcutEnabled.addEventListener("change", () => {
  settings.shortcutEnabled = els.shortcutEnabled.checked;
  save();
});
els.shortcutBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

els.openPages.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("pages.html") });
});

/* ----------------------------------------------------------------- Load */
async function load() {
  settings = await getSettings();
  const pages = await getPages();
  const keys = Object.keys(pages);
  const total = keys.reduce((n, k) => n + (pages[k].comments || []).length, 0);
  els.pagesSummary.textContent = keys.length
    ? `${keys.length} page${keys.length === 1 ? "" : "s"} · ${total} note${total === 1 ? "" : "s"}`
    : "No commented pages yet";
  els.version.textContent = `SideNote v${chrome.runtime.getManifest().version}`;
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[PAGES_KEY]) load();
});

load();
