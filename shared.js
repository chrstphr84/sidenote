// Shared constants and pure helpers, loaded first in every context
// (content script, popup, options, pages, changelog, help) and via
// importScripts() in the background service worker.
//
// Storage layout
// --------------
//   chrome.storage.sync   SETTINGS_KEY  -> small user settings (theme, sides…)
//   chrome.storage.local  PAGES_KEY     -> per-page notes (can grow large)
//
// A page's key strips the hash so in-page anchors don't fork a page's notes,
// but keeps the query string (it often changes what the page shows).

const SETTINGS_KEY = "sidenoteSettingsV1";
const PAGES_KEY = "sidenotePagesV1";

const THEME_VALUES = ["auto", "light", "dark"];
const SIDES_VALUES = ["left", "right", "both"];

const DEFAULT_SETTINGS = {
  theme: "auto",
  masterEnabled: true,
  defaultSides: "right",
  highlightColor: "#ffe066",
  marginWidth: 320
};

const ACCENT = "#1a73e8";

/* ------------------------------------------------------------- Settings */
function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === "object") {
    if (THEME_VALUES.includes(raw.theme)) s.theme = raw.theme;
    if (typeof raw.masterEnabled === "boolean") s.masterEnabled = raw.masterEnabled;
    if (SIDES_VALUES.includes(raw.defaultSides)) s.defaultSides = raw.defaultSides;
    if (/^#([A-Fa-f0-9]{6})$/.test(String(raw.highlightColor || ""))) {
      s.highlightColor = raw.highlightColor;
    }
    const w = Number(raw.marginWidth);
    if (Number.isFinite(w)) s.marginWidth = Math.min(Math.max(Math.round(w), 240), 520);
  }
  return s;
}

/* ---------------------------------------------------------------- URLs */
function buildUrl(href) {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

// Notes are filed under this key. Hash is dropped; query is kept.
function pageKeyFromHref(href) {
  const url = buildUrl(href);
  if (!url) return "";
  return `${url.origin}${url.pathname}${url.search}`;
}

// Content scripts only run on these; the popup uses this to disable controls
// on browser-internal pages.
function isSupportedPageUrl(href) {
  const url = buildUrl(href);
  if (!url) return false;
  return ["http:", "https:", "file:"].includes(url.protocol);
}

/* --------------------------------------------------------------- Pages */
// A page entry: { url, title, updatedAt, enabled?, sides?, comments: [] }
// A comment:    { id, anchor:{exact,prefix,suffix,index}, body, side,
//                 color, resolved, createdAt, updatedAt }

function normalizePages(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const comments = Array.isArray(entry.comments) ? entry.comments.filter(Boolean) : [];
    out[key] = {
      url: String(entry.url || key),
      title: String(entry.title || ""),
      updatedAt: Number(entry.updatedAt) || 0,
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
      sides: SIDES_VALUES.includes(entry.sides) ? entry.sides : undefined,
      comments
    };
  }
  return out;
}

// Whether SideNote should be live on a page. A page with notes is on by
// default; an empty page is off until turned on; an explicit toggle wins.
function isPageEnabled(entry, settings) {
  if (settings && settings.masterEnabled === false) return false;
  if (!entry) return false;
  if (typeof entry.enabled === "boolean") return entry.enabled;
  return (entry.comments || []).length > 0;
}

function effectiveSides(entry, settings) {
  if (entry && SIDES_VALUES.includes(entry.sides)) return entry.sides;
  return settings ? settings.defaultSides : DEFAULT_SETTINGS.defaultSides;
}

function unresolvedCount(entry) {
  if (!entry || !Array.isArray(entry.comments)) return 0;
  return entry.comments.filter((c) => !c.resolved).length;
}

/* ---------------------------------------------------------- Storage IO */
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([SETTINGS_KEY], (items) => resolve(normalizeSettings(items[SETTINGS_KEY])));
  });
}

function setSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [SETTINGS_KEY]: normalizeSettings(settings) }, resolve);
  });
}

function getPages() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PAGES_KEY], (items) => resolve(normalizePages(items[PAGES_KEY])));
  });
}

function setPages(pages) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PAGES_KEY]: pages }, resolve);
  });
}

/* ------------------------------------------------------------- Theme */
function resolveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  const dark = typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark ? "dark" : "light";
}

/* --------------------------------------------------------------- Misc */
function genId(prefix) {
  return `${prefix || "id"}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function hostLabel(href) {
  const url = buildUrl(href);
  return url ? url.hostname.replace(/^www\./, "") : href || "";
}
