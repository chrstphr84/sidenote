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
  // Highlights are translucent so the text underneath stays readable (a solid
  // fill can hide light text on dark themes).
  highlightOpacity: 0.4,
  marginWidth: 320,
  // How notes get added. At least one of addSelectionButton / addContextMenu
  // must stay on (enforced in normalizeSettings).
  addSelectionButton: true, // the floating "Add note" button on text selection
  addContextMenu: true, // the right-click menu items
  shortcutEnabled: true, // the keyboard command (rebindable at chrome://extensions/shortcuts)
  // Sidebar layout: "aligned" (each card tracks its anchor's vertical position,
  // Google-Docs style — the default) or "list" (a plain scrolling list).
  sidebarLayout: "aligned",
  // The speech-bubble margin tab (FAB).
  showTab: true, // show the open/close tab on the page edge
  // When the tab is hidden, holding Option (mac) / Alt (win) reveals it.
  revealTabOnModifier: true,
  fabPosition: 0.5, // vertical position as a fraction of the viewport (draggable)
  drawColor: "#f24822", // last-used ink color for the drawing tools
  googleClientId: "", // user's own OAuth client ID for Google Doc/Sheet export
  requireExplicitSave: false, // when true, a new note is discarded unless Saved
  // Where SideNote is on. "all" = every site except domainList (a block list);
  // "allow" = only sites in domainList. A per-page toggle overrides either way.
  domainMode: "all",
  domainList: []
};

const DOMAIN_MODES = ["all", "allow"];
const LAYOUT_VALUES = ["list", "aligned"];

const ACCENT = "#1a73e8";

// Highlighter presets offered per note (yellow, blue, green, red, orange, purple).
const HIGHLIGHT_PALETTE = ["#ffe066", "#a5d8ff", "#b2f2bb", "#ffc9c9", "#ffd8a8", "#eebefa"];

// Ink presets for the drawing tools (red, blue, green, amber, ink).
const DRAW_PALETTE = ["#f24822", "#1a73e8", "#12b886", "#f59f00", "#212529"];

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
    const op = Number(raw.highlightOpacity);
    if (Number.isFinite(op)) s.highlightOpacity = Math.min(1, Math.max(0.1, op));
    if (typeof raw.addSelectionButton === "boolean") s.addSelectionButton = raw.addSelectionButton;
    if (typeof raw.addContextMenu === "boolean") s.addContextMenu = raw.addContextMenu;
    if (typeof raw.shortcutEnabled === "boolean") s.shortcutEnabled = raw.shortcutEnabled;
    if (LAYOUT_VALUES.includes(raw.sidebarLayout)) s.sidebarLayout = raw.sidebarLayout;
    if (typeof raw.showTab === "boolean") s.showTab = raw.showTab;
    if (typeof raw.revealTabOnModifier === "boolean") s.revealTabOnModifier = raw.revealTabOnModifier;
    const fp = Number(raw.fabPosition);
    if (Number.isFinite(fp)) s.fabPosition = Math.min(0.95, Math.max(0.05, fp));
    if (/^#([A-Fa-f0-9]{6})$/.test(String(raw.drawColor || ""))) s.drawColor = raw.drawColor;
    if (typeof raw.googleClientId === "string") s.googleClientId = raw.googleClientId.trim();
    if (typeof raw.requireExplicitSave === "boolean") s.requireExplicitSave = raw.requireExplicitSave;
    if (DOMAIN_MODES.includes(raw.domainMode)) s.domainMode = raw.domainMode;
    if (Array.isArray(raw.domainList)) {
      s.domainList = raw.domainList.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean);
    }
  }
  // Keep at least one primary add-method enabled.
  if (!s.addSelectionButton && !s.addContextMenu) s.addSelectionButton = true;
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
// A comment:    { id, anchor:{exact,prefix,suffix,index}, body, side, color,
//                 resolved, createdAt, updatedAt, replies: [] }
// A reply:      { id, body, createdAt, updatedAt }

function normalizeReply(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: String(raw.id || genId("reply")),
    body: String(raw.body || ""),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now()
  };
}

const ANCHOR_TYPES = ["text", "element", "region"];
const SHAPE_KINDS = ["rect", "ellipse", "line", "arrow", "freehand"];

// A robust element locator: several independent signals scored on re-find, so a
// linked button/image survives minor DOM churn (mirrors the text anchor's
// prefix/suffix/index resilience). rect is a viewport-relative hint captured at
// creation, used only as a last-resort tiebreaker.
function normalizeTarget(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  return {
    selector: String(t.selector || ""),
    xpath: String(t.xpath || ""),
    tag: String(t.tag || ""),
    id: String(t.id || ""),
    classes: Array.isArray(t.classes) ? t.classes.map(String) : [],
    textHint: String(t.textHint || ""),
    attrHint: String(t.attrHint || ""), // alt / aria-label / title / value
    nthOfType: Number(t.nthOfType) || 0,
    rect: t.rect && typeof t.rect === "object"
      ? { w: Number(t.rect.w) || 0, h: Number(t.rect.h) || 0 }
      : undefined
  };
}

function normalizeShape(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = SHAPE_KINDS.includes(raw.kind) ? raw.kind : "rect";
  const points = Array.isArray(raw.points)
    ? raw.points
        .map((p) => ({ x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    : [];
  return {
    kind,
    points,
    color: /^#([A-Fa-f0-9]{6})$/.test(String(raw.color || "")) ? raw.color : "#f24822",
    width: Number(raw.width) || 3
  };
}

// The anchor is a typed union: text (quote), element (locator), or region
// (shapes drawn relative to an element or the page). Legacy anchors have no
// `type` and carry exact/prefix/suffix/index → normalized as "text".
function normalizeAnchor(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const type = ANCHOR_TYPES.includes(a.type) ? a.type : "text";
  const out = { type };
  if (type === "text") {
    out.exact = String(a.exact || "");
    out.prefix = String(a.prefix || "");
    out.suffix = String(a.suffix || "");
    out.index = Number(a.index) || 0;
  } else {
    out.target = normalizeTarget(a.target);
  }
  if (type === "region") {
    out.relativeTo = a.relativeTo === "page" ? "page" : "element";
    out.shapes = Array.isArray(a.shapes) ? a.shapes.map(normalizeShape).filter(Boolean) : [];
  }
  return out;
}

function normalizeComment(raw) {
  if (!raw || typeof raw !== "object") return null;
  // A note can point at several page annotations (consolidation). Legacy notes
  // stored a single `anchor` — migrate those into the anchors[] model.
  const rawAnchors = Array.isArray(raw.anchors)
    ? raw.anchors
    : raw.anchor
    ? [raw.anchor]
    : [];
  const anchors = rawAnchors.filter(Boolean).map(normalizeAnchor);
  if (anchors.length === 0) return null;
  return {
    id: String(raw.id || genId("note")),
    anchors,
    // Notes sharing a linkGroup are linked: kept adjacent and navigable.
    linkGroup: typeof raw.linkGroup === "string" && raw.linkGroup ? raw.linkGroup : undefined,
    body: String(raw.body || ""),
    side: raw.side === "left" ? "left" : "right",
    color: /^#([A-Fa-f0-9]{6})$/.test(String(raw.color || "")) ? raw.color : undefined,
    resolved: Boolean(raw.resolved),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
    replies: Array.isArray(raw.replies) ? raw.replies.map(normalizeReply).filter(Boolean) : []
  };
}

function normalizePages(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const comments = Array.isArray(entry.comments)
      ? entry.comments.map(normalizeComment).filter(Boolean)
      : [];
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

function hostFromHref(href) {
  const url = buildUrl(href);
  return url ? url.hostname.toLowerCase() : "";
}

// A domain pattern matches a host exactly, as a parent domain (covers
// subdomains), or via a `*` wildcard.
function domainPatternMatches(pattern, host) {
  const p = String(pattern || "").trim().toLowerCase();
  const h = String(host || "").toLowerCase();
  if (!p || !h) return false;
  if (p.includes("*")) {
    const rx = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return rx.test(h);
  }
  return h === p || h.endsWith("." + p);
}

// Whether the domain rules allow a host: "all" = anywhere except the list
// (block list); "allow" = only hosts in the list.
function domainAllowsHost(settings, host) {
  const list = settings && Array.isArray(settings.domainList) ? settings.domainList : [];
  const listed = list.some((p) => domainPatternMatches(p, host));
  if (settings && settings.domainMode === "allow") return listed;
  return !listed;
}

// Whether SideNote should be live on a page. Master on → pages are on by
// default (subject to the domain rules); an explicit per-page toggle always
// wins in either direction.
function isPageEnabled(entry, settings, href) {
  if (!settings || settings.masterEnabled === false) return false;
  if (entry && typeof entry.enabled === "boolean") return entry.enabled;
  const host = hostFromHref(href) || (entry ? hostFromHref(entry.url) : "");
  return domainAllowsHost(settings, host);
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
// The anchor a note is primarily represented by (its first).
function primaryAnchor(c) {
  return c && Array.isArray(c.anchors) ? c.anchors[0] : null;
}

// Order notes so linked ones sit together: a link group takes the position of
// its earliest member, and its members follow in their existing order.
function orderLinked(list) {
  const out = [];
  const seen = new Set();
  (list || []).forEach((c) => {
    if (seen.has(c.id)) return;
    if (!c.linkGroup) {
      seen.add(c.id);
      out.push(c);
      return;
    }
    list
      .filter((x) => x.linkGroup === c.linkGroup)
      .forEach((x) => {
        if (seen.has(x.id)) return;
        seen.add(x.id);
        out.push(x);
      });
  });
  return out;
}

// "#rrggbb" + alpha → "rgba(r, g, b, a)". Used for highlight fills so page text
// stays readable through the highlight.
function hexWithAlpha(hex, alpha) {
  const clean = String(hex || "").trim();
  const a = Number.isFinite(Number(alpha)) ? Math.min(1, Math.max(0, Number(alpha))) : 1;
  if (!/^#([A-Fa-f0-9]{6})$/.test(clean)) return clean || "transparent";
  const r = parseInt(clean.slice(1, 3), 16);
  const g = parseInt(clean.slice(3, 5), 16);
  const b = parseInt(clean.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function genId(prefix) {
  return `${prefix || "id"}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function hostLabel(href) {
  const url = buildUrl(href);
  return url ? url.hostname.replace(/^www\./, "") : href || "";
}
