// Dedicated changelog page. Mirrors help.js for theme + back + version, and
// renders the releases from changelog.json (the single source of truth, also
// consumed by tools/gen-changelog.mjs to produce CHANGELOG.md).
//
// To add a release: prepend an entry to changelog.json and bump the manifest.

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

function renderChangelog(releases) {
  const list = document.getElementById("changelog-list");
  list.innerHTML = "";
  releases.forEach((entry) => {
    const card = document.createElement("section");
    card.className = "card";

    const h2 = document.createElement("h2");
    h2.textContent = `v${entry.version}`;
    card.appendChild(h2);

    (entry.sections || []).forEach((section) => {
      const h3 = document.createElement("h3");
      h3.textContent = section.label;
      card.appendChild(h3);

      const ul = document.createElement("ul");
      (section.items || []).forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      });
      card.appendChild(ul);
    });

    list.appendChild(card);
  });
}

function showChangelogError() {
  const list = document.getElementById("changelog-list");
  list.innerHTML = "";
  const card = document.createElement("section");
  card.className = "card";
  const p = document.createElement("p");
  p.className = "intro";
  p.textContent = "Unable to load the changelog.";
  card.appendChild(p);
  list.appendChild(card);
}

fetch(chrome.runtime.getURL("changelog.json"))
  .then((res) => res.json())
  .then((releases) => renderChangelog(Array.isArray(releases) ? releases : []))
  .catch(showChangelogError);

const backBtn = document.getElementById("back-btn");
if (backBtn) {
  backBtn.addEventListener("click", () => {
    if (window.history.length > 1) window.history.back();
    else chrome.runtime.openOptionsPage();
  });
}

const versionEl = document.getElementById("ext-version");
if (versionEl) versionEl.textContent = `SideNote v${chrome.runtime.getManifest().version}`;
