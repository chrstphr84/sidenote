// Help page: theme sync, Back button, and the version line.

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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[SETTINGS_KEY]) applyStoredTheme();
});

const backBtn = document.getElementById("back-btn");
if (backBtn) {
  backBtn.addEventListener("click", () => {
    if (window.history.length > 1) window.history.back();
    else chrome.runtime.openOptionsPage();
  });
}

const versionEl = document.getElementById("ext-version");
if (versionEl) versionEl.textContent = `SideNote v${chrome.runtime.getManifest().version}`;
