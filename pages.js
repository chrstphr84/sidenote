// All-notes page: lists every commented page with its notes, and supports
// removing pages individually, in bulk (selection), or all at once. Opens in
// its own tab because the list can get long.

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
let settings = { ...DEFAULT_SETTINGS };
let pages = {};
const linkStatus = {}; // pageKey -> { label, cls } from the last link check

const els = {
  list: document.getElementById("list"),
  toolbar: document.getElementById("toolbar"),
  selectAll: document.getElementById("select-all"),
  removeSelected: document.getElementById("remove-selected"),
  settingsBtn: document.getElementById("settings-btn"),
  exportFormat: document.getElementById("export-format"),
  exportBtn: document.getElementById("export-btn"),
  checkLinks: document.getElementById("check-links"),
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
  const a = c.anchor || {};
  let head;
  if ((a.type || "text") === "text") {
    const q = String(a.exact || "");
    head = `“${esc(q.length > 90 ? q.slice(0, 90) + "…" : q)}”`;
  } else {
    // Element / drawing notes have no quoted text — show a typed descriptor.
    head = esc(exportAnchorLabel(a));
  }
  const body = c.body ? ` — ${esc(c.body.length > 120 ? c.body.slice(0, 120) + "…" : c.body)}` : "";
  const replies = (c.replies || []).length;
  const repliesLabel = replies ? ` <span style="color:var(--text-faint)">· ${replies} repl${replies === 1 ? "y" : "ies"}</span>` : "";
  return `<div class="page-note"><b>${head}</b>${body}${repliesLabel}</div>`;
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
      const st = linkStatus[key];
      const badge = st ? ` · <span class="link-badge ${st.cls}">${esc(st.label)}</span>` : "";
      return `<div class="page-item" data-key="${esc(key)}">
          <input type="checkbox" class="select" data-key="${esc(key)}" />
          <div class="page-info">
            <div class="page-title"><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a></div>
            <div class="page-url">${esc(e.url)}</div>
            <div class="page-meta">${total} note${total === 1 ? "" : "s"} · ${open} open · updated ${esc(formatTime(e.updatedAt))}${badge}</div>
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

  const scope = checked.length ? checked.length : boxes.length;
  els.exportBtn.textContent = checked.length ? `Export selected (${scope})` : `Export all (${scope})`;
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

els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

/* ----------------------------------------------------------- Link check */
// Best-effort reachability. Cross-origin quirks mean this can't be perfect:
// a sign-in wall or a server that blocks HEAD isn't a dead page, so we label
// those distinctly and never delete anything automatically.
function classifyStatus(status) {
  if (status >= 200 && status < 400) return { label: "Reachable", cls: "ok" };
  if (status === 401 || status === 403) return { label: "Sign-in required", cls: "warn" };
  if (status === 404 || status === 410) return { label: "Not found", cls: "err" };
  if (status === 405 || status === 501) return { label: "Reachable", cls: "ok" }; // HEAD not allowed, but it answered
  return { label: `HTTP ${status}`, cls: "warn" };
}

async function probe(url) {
  if (!/^https?:/i.test(url)) return { label: "Can't check", cls: "warn" };
  const attempt = async (method) => {
    const res = await fetch(url, { method, credentials: "include", redirect: "follow" });
    return classifyStatus(res.status);
  };
  try {
    return await attempt("HEAD");
  } catch (_) {
    try {
      return await attempt("GET");
    } catch (_) {
      return { label: "Unreachable", cls: "err" };
    }
  }
}

async function runPool(items, worker, concurrency) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

els.checkLinks.addEventListener("click", async () => {
  const keys = sortedKeys();
  if (keys.length === 0) return;
  els.checkLinks.disabled = true;
  els.checkLinks.textContent = "Checking…";
  keys.forEach((k) => (linkStatus[k] = { label: "Checking…", cls: "warn" }));
  render();
  await runPool(
    keys,
    async (key) => {
      linkStatus[key] = await probe(pages[key].url);
      render();
    },
    5
  );
  els.checkLinks.disabled = false;
  els.checkLinks.textContent = "Check links";
});

/* --------------------------------------------------------------- Export */
function exportScope() {
  const selected = selectedKeys();
  const keys = selected.length ? selected : Object.keys(pages);
  const subset = {};
  keys.forEach((k) => {
    if (pages[k]) subset[k] = pages[k];
  });
  return subset;
}

function downloadFile(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function printHtml(html) {
  const w = window.open("", "_blank");
  if (!w) {
    toast("Allow pop-ups to export a PDF");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  // Give the new document a tick to lay out, then open the print dialog
  // (the user picks "Save as PDF").
  w.onload = () => setTimeout(() => w.print(), 150);
}

els.exportBtn.addEventListener("click", () => {
  const subset = exportScope();
  if (Object.keys(subset).length === 0) {
    toast("Nothing to export");
    return;
  }
  const fmt = els.exportFormat.value;
  const base = `sidenote-export-${stamp()}`;
  if (fmt === "markdown") {
    downloadFile(`${base}.md`, toMarkdown(subset), "text/markdown");
    toast("Exported");
  } else if (fmt === "plaintext") {
    downloadFile(`${base}.txt`, toPlaintext(subset), "text/plain");
    toast("Exported");
  } else if (fmt === "csv") {
    downloadFile(`${base}.csv`, toCsv(subset), "text/csv");
    toast("Exported");
  } else if (fmt === "pdf") {
    printHtml(toExportHtml(subset));
    toast("Opening print view…");
  } else if (fmt === "gdoc" || fmt === "gsheet") {
    exportToGoogle(fmt, subset, base);
  }
});

async function exportToGoogle(fmt, subset, base) {
  const s = await getSettings();
  if (!s.googleClientId) {
    toast("Add your Google client ID in Settings first");
    return;
  }
  els.exportBtn.disabled = true;
  toast("Connecting to Google…");
  try {
    const token = await getGoogleToken(s.googleClientId, true);
    const file =
      fmt === "gdoc"
        ? await createGoogleDoc(token, base, toExportHtml(subset))
        : await createGoogleSheet(token, base, toCsv(subset));
    chrome.tabs.create({ url: googleFileLink(file, fmt) });
    toast(fmt === "gdoc" ? "Created Google Doc" : "Created Google Sheet");
  } catch (e) {
    const msg = e && e.message ? e.message : "error";
    toast(msg === "no-client-id" ? "Add your Google client ID in Settings" : `Google export failed (${msg})`);
  } finally {
    els.exportBtn.disabled = false;
  }
}

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
