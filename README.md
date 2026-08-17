# SideNote Chrome Extension

SideNote lets you attach comments to highlighted text on any web page, shown in
a margin beside the page — like comments in Google Docs. It's built for the
"I have this tab open because I need to remember something about it" problem:
mark the exact spot, write why it matters, and come back to it later.

This is an early **proof of concept** (v0.18.0). See [ROADMAP.md](ROADMAP.md) for what's planned and how it's sequenced.

## Features

- Attach a comment to any text selection; the text is highlighted on the page and
  the comment appears in a side margin, linked to that highlight.
- **Link a note to any element** (button, image, link) from the right-click menu — the
  element is marked with a pin, no highlight needed. Right-clicking a custom control
  attaches to its label/control, and you can link the **exact** element from DevTools →
  Elements → the **SideNote** sidebar pane (handy for checkboxes and other fiddly targets).
- **Draw on the page** — a palette (opened from the panel header) of rectangle, ellipse,
  line, arrow, and freehand tools; each drawing becomes a note and anchors to the element
  beneath it (or the page). **Undo** with ⌘Z / Ctrl+Z, click a drawing to **select and
  delete** just that piece, and dismiss the palette with **Done** or **Esc**.
- **Three ways to add a note**, each toggleable in Settings (one always stays on): the
  floating selection button, the right-click menu, and a rebindable keyboard shortcut
  (`Alt+Shift+N`).
- **Hover a note to see where it's linked** — its highlight or pin is emphasized on the
  page, and hovering the target emphasizes its note.
- **Two sidebar layouts** (Settings): **Aligned** (default) — each note sits next to its
  highlight and follows it as you scroll, like Google Docs comments — or a scrolling **List**.
- **Translucent highlights** with an adjustable opacity, so the page text underneath stays
  readable (including light text on dark pages).
- **Threaded replies** on any note; edit or delete individual replies.
- **Per-note highlight color** — pick from a palette on each note, and the on-page
  highlight updates to match.
- **Single-page-app aware**: when a site swaps the page without a full reload, SideNote
  re-keys to the new page's notes automatically (via the Navigation API, falling back to
  polling on older Chrome).
- Click a highlight to jump to its note, and a note's quote to scroll back to the text.
- Margin can sit on the **Left**, **Right**, or **Both** sides — a default in
  Settings, overridable per page from the popup.
- Open and close the margin from a tab on the page edge (drag it to reposition, or hide
  it in Settings); closing it never loses notes.
- **Plays nicely with a top bar** — if another extension (e.g. Colorbars) docks a bar at
  the top of the page, the margin tucks below it automatically, and re-adjusts if that
  bar resizes or is turned off.
- **On everywhere by default** when the master switch is on; turn a page off individually
  from the popup, or scope where it runs with **All sites (block list)** or **Only listed
  sites** rules in Settings → *Where SideNote runs*.
- Notes are saved locally, keyed by page, so they return after you close the tab or
  the whole window and revisit the page later.
- Highlights **re-anchor** to their text on reload using the surrounding context (and
  tolerate whitespace/formatting changes); if a page changes so the text is gone, the note
  is kept, flagged, and can be **re-anchored** by selecting the new spot on the page.
- **Check links** on the All notes page flags pages that are Not found / Unreachable /
  Sign-in required (best-effort — nothing is ever deleted automatically).
- On-page indication of notes: the highlights themselves plus a **toolbar badge**
  counting the open notes on the current page.
- Per-note actions: **edit**, **resolve** (kept with a strikethrough, still deletable),
  **move to the other side**, and **delete**.
- **All notes** page (its own tab, reachable from the sidebar title) listing every commented
  page, with **remove single** and **remove selected**.
- **Export** all or selected pages as **Markdown, plain text, CSV, PDF** (print view), or
  straight into a **Google Doc / Google Sheet** (using your own Google OAuth client,
  configured in Settings).
- **Settings** page (its own tab) with Light / Dark / Auto theme, default margin side,
  highlight color, and margin width — styled to match the Colorbars extension.
- In-extension **Help** and **Changelog** pages.

## Install (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `sidenote`.

## Using it

1. Click the SideNote toolbar icon and turn **This page** on (pages with existing
   notes turn on by themselves).
2. Select some text. An **Add note** button appears next to the selection — click it,
   type your note, and **Save**.
3. Reopen the margin any time from the tab on the edge of the page. Manage everything
   from **All notes**.

## How notes are stored

- **Settings** live in `chrome.storage.sync` (theme, default side, highlight color,
  margin width, master switch).
- **Notes** live in `chrome.storage.local`, keyed by page (origin + path + query; the
  URL hash is ignored). Each note stores its text plus the surrounding context used to
  re-find the highlight on the next visit.

## Google export setup

Google Doc/Sheet export uses **your own** Google OAuth client (a client ID is not a
secret, so nothing is committed here). One-time setup, from **Settings → Google export**:

1. Reload the extension, open Settings, and copy the **Redirect URI** shown there.
2. In [Google Cloud Console](https://console.cloud.google.com): enable the **Google Drive API**.
3. OAuth consent screen: **External**, add yourself as a **Test user**, add scope `drive.file`.
4. Create an **OAuth client ID** of type **Web application**, and add the Redirect URI from step 1.
5. Paste the **Client ID** into Settings. Then use **Export → Google Doc / Google Sheet**.

SideNote requests only the `drive.file` scope — it can create and open the files it makes,
and nothing else in your Drive. Export HTML is converted by Drive to a Doc; CSV to a Sheet.

## Project layout

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `shared.js` | Constants and helpers shared by every context |
| `background.js` | Seeds settings; keeps the toolbar badge count current |
| `content.js` / `content.css` | The on-page margin, highlights, and selection flow |
| `popup.html` / `popup.js` | Toolbar popup (per-page on/off, side, shortcuts) |
| `options.html` / `options.js` | Settings page |
| `pages.html` / `pages.js` | All-notes page |
| `export.js` | Pure note→Markdown/plaintext/CSV/HTML transforms (used by the All-notes page) |
| `google.js` | Google OAuth (launchWebAuthFlow) + Drive upload for Doc/Sheet export |
| `devtools.html` / `devtools.js` | Registers the Elements-panel sidebar pane |
| `devtools-sidebar.html` / `devtools-sidebar.js` | "Link selected element" pane (uses `$0`) |
| `help.html` / `help.js` | Help page |
| `changelog.html` / `changelog.js` / `changelog.json` | Changelog page + data |
| `options.css` | Shared styling for all extension pages |
| `tools/gen-changelog.mjs` | Generates `CHANGELOG.md` from `changelog.json` |
| `icons/` | Toolbar/store icons (`source.svg` is the master) |

## Development notes

- The changelog has a single source of truth: `changelog.json`. After editing it,
  regenerate the markdown with `node tools/gen-changelog.mjs` and bump the version in
  `manifest.json`.
- Icons are rasterized from `icons/source.svg`:
  `for s in 16 32 48 128; do rsvg-convert -w $s -h $s icons/source.svg -o icons/icon$s.png; done`
- The margin UI is rendered inside a Shadow DOM so the page's own CSS can't distort it;
  highlight spans live in the page and are styled defensively in `content.css`.

## Known limitations (proof of concept)

- Re-anchoring is text-based; heavily dynamic pages may fail to relocate a highlight
  (the note is preserved and flagged).
- Single-page-app navigation is detected via the Navigation API (with a polling fallback);
  routes that reuse the same URL for different content still can't be told apart.
- Notes are stored locally and are not synced across devices.
