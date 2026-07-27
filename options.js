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
  showTab: document.getElementById("show-tab"),
  addSelection: document.getElementById("add-selection"),
  addContext: document.getElementById("add-context"),
  requireSave: document.getElementById("require-save"),
  shortcutEnabled: document.getElementById("shortcut-enabled"),
  shortcutBtn: document.getElementById("shortcut-btn"),
  pagesSummary: document.getElementById("pages-summary"),
  openPages: document.getElementById("open-pages"),
  googleClientId: document.getElementById("google-client-id"),
  redirectUri: document.getElementById("redirect-uri"),
  copyRedirect: document.getElementById("copy-redirect"),
  googleTest: document.getElementById("google-test"),
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
  els.showTab.checked = settings.showTab;
  els.googleClientId.value = settings.googleClientId || "";
  els.addSelection.checked = settings.addSelectionButton;
  els.addContext.checked = settings.addContextMenu;
  els.requireSave.checked = settings.requireExplicitSave;
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

els.showTab.addEventListener("change", () => {
  settings.showTab = els.showTab.checked;
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
els.requireSave.addEventListener("change", () => {
  settings.requireExplicitSave = els.requireSave.checked;
  save();
});

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

/* ------------------------------------------------------- Google export */
if (chrome.identity && chrome.identity.getRedirectURL) {
  els.redirectUri.textContent = chrome.identity.getRedirectURL();
}

els.googleClientId.addEventListener("change", () => {
  settings.googleClientId = els.googleClientId.value.trim();
  settings = normalizeSettings(settings);
  save();
});

els.copyRedirect.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.redirectUri.textContent);
    toast("Redirect URI copied");
  } catch (_) {
    toast("Copy failed — select it manually");
  }
});

els.googleTest.addEventListener("click", async () => {
  const clientId = els.googleClientId.value.trim();
  if (!clientId) {
    toast("Enter your client ID first");
    return;
  }
  settings.googleClientId = clientId;
  await setSettings(settings);
  els.googleTest.disabled = true;
  els.googleTest.textContent = "Connecting…";
  try {
    clearGoogleToken();
    await getGoogleToken(clientId, true);
    toast("Connected to Google");
    els.googleTest.textContent = "Connected ✓";
  } catch (e) {
    toast(`Connection failed (${e && e.message ? e.message : "error"})`);
    els.googleTest.textContent = "Connect Google";
  } finally {
    els.googleTest.disabled = false;
    setTimeout(() => (els.googleTest.textContent = "Connect Google"), 2500);
  }
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
