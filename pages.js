// All-notes page: lists every commented page with its notes, and supports
// removing pages individually, in bulk (selection), or all at once. Opens in
// its own tab because the list can get long.

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
let settings = { ...DEFAULT_SETTINGS };
let pages = {};

const els = {
  list: document.getElementById("list"),
  toolbar: document.getElementById("toolbar"),
  selectAll: document.getElementById("select-all"),
  removeSelected: document.getElementById("remove-selected"),
  clearAll: document.getElementById("clear-all"),
  settingsBtn: document.getElementById("settings-btn"),
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
  setTimeout(() => els.toast.classList.remove("show"), 1800);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  } catch (_) {
    return "";
  }
}

function sortedKeys() {
  return Object.keys(pages).sort((a, b) => (pages[b].updatedAt || 0) - (pages[a].updatedAt || 0));
}

function noteSnippet(c) {
  const quote = esc(c.anchor.exact.length > 90 ? c.anchor.exact.slice(0, 90) + "…" : c.anchor.exact);
  const body = c.body ? ` — ${esc(c.body.length > 120 ? c.body.slice(0, 120) + "…" : c.body)}` : "";
  return `<div class="page-note"><b>“${quote}”</b>${body}</div>`;
}

function render() {
  applyTheme();
  const keys = sortedKeys();
  els.toolbar.hidden = keys.length === 0;

  if (keys.length === 0) {
    els.list.innerHTML = `<div class="empty-state">
        <p>No commented pages yet.</p>
        <p class="intro">Turn SideNote on for a page, select some text, and choose <strong>Add note</strong>.</p>
      </div>`;
    return;
  }

  els.list.innerHTML = keys
    .map((key) => {
      const e = pages[key];
      const total = (e.comments || []).length;
      const open = unresolvedCount(e);
      const title = e.title || hostLabel(e.url);
      const notes = (e.comments || []).slice(0, 4).map(noteSnippet).join("");
      const more = total > 4 ? `<div class="page-note" style="border:none;color:var(--text-faint)">+${total - 4} more</div>` : "";
      return `<div class="page-item" data-key="${esc(key)}">
          <input type="checkbox" class="select" data-key="${esc(key)}" />
          <div class="page-info">
            <div class="page-title"><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a></div>
            <div class="page-url">${esc(e.url)}</div>
            <div class="page-meta">${total} note${total === 1 ? "" : "s"} · ${open} open · updated ${esc(formatTime(e.updatedAt))}</div>
            <div class="page-notes">${notes}${more}</div>
          </div>
          <div class="row" style="gap:8px; align-items:flex-start">
            <span class="pill">${total}</span>
            <button class="danger remove" type="button" data-key="${esc(key)}">Remove</button>
          </div>
        </div>`;
    })
    .join("");

  syncBulkState();
}

function selectedKeys() {
  return Array.from(els.list.querySelectorAll(".select:checked")).map((c) => c.dataset.key);
}

function syncBulkState() {
  const boxes = Array.from(els.list.querySelectorAll(".select"));
  const checked = boxes.filter((b) => b.checked);
  els.removeSelected.disabled = checked.length === 0;
  els.removeSelected.textContent = checked.length
    ? `Remove selected (${checked.length})`
    : "Remove selected";
  els.selectAll.checked = boxes.length > 0 && checked.length === boxes.length;
  els.selectAll.indeterminate = checked.length > 0 && checked.length < boxes.length;
}

async function removeKeys(keys) {
  keys.forEach((k) => delete pages[k]);
  await setPages(pages);
  render();
}

/* --------------------------------------------------------------- Wiring */
els.list.addEventListener("change", (e) => {
  if (e.target.classList.contains("select")) syncBulkState();
});

els.list.addEventListener("click", (e) => {
  const btn = e.target.closest("button.remove");
  if (!btn) return;
  removeKeys([btn.dataset.key]);
  toast("Page removed");
});

els.selectAll.addEventListener("change", () => {
  els.list.querySelectorAll(".select").forEach((b) => (b.checked = els.selectAll.checked));
  syncBulkState();
});

els.removeSelected.addEventListener("click", () => {
  const keys = selectedKeys();
  if (keys.length === 0) return;
  removeKeys(keys);
  toast(`${keys.length} page${keys.length === 1 ? "" : "s"} removed`);
});

els.clearAll.addEventListener("click", () => {
  const count = Object.keys(pages).length;
  if (count === 0) return;
  if (!window.confirm(`Remove all notes from ${count} page${count === 1 ? "" : "s"}? This can't be undone.`)) return;
  pages = {};
  setPages(pages).then(render);
  toast("All notes cleared");
});

els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

/* ----------------------------------------------------------------- Load */
async function load() {
  settings = await getSettings();
  pages = await getPages();
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[PAGES_KEY]) {
    getPages().then((p) => {
      pages = p;
      render();
    });
  }
  if (area === "sync" && changes[SETTINGS_KEY]) {
    getSettings().then((s) => {
      settings = s;
      applyTheme();
    });
  }
});

load();
