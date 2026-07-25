# SideNote Chrome Extension

SideNote lets you attach comments to highlighted text on any web page, shown in
a margin beside the page — like comments in Google Docs. It's built for the
"I have this tab open because I need to remember something about it" problem:
mark the exact spot, write why it matters, and come back to it later.

This is an early **proof of concept** (v0.2.0).

## Features

- Attach a comment to any text selection; the text is highlighted on the page and
  the comment appears in a side margin, linked to that highlight.
- **Threaded replies** on any note; edit or delete individual replies.
- **Per-note highlight color** — pick from a palette on each note, and the on-page
  highlight updates to match.
- **Single-page-app aware**: when a site swaps the page without a full reload, SideNote
  re-keys to the new page's notes automatically (via the Navigation API, falling back to
  polling on older Chrome).
- Click a highlight to jump to its note, and a note's quote to scroll back to the text.
- Margin can sit on the **Left**, **Right**, or **Both** sides — a default in
  Settings, overridable per page from the popup.
- Open and close the margin from a tab on the page edge; closing it never loses notes.
- Turn SideNote **on or off per page** from the toolbar popup, plus an **All pages**
  master switch. Pages that already have notes turn on automatically.
- Notes are saved locally, keyed by page, so they return after you close the tab or
  the whole window and revisit the page later.
- Highlights **re-anchor** to their text on reload using the surrounding context; if
  a page changes so the text is gone, the note is kept and flagged rather than lost.
- On-page indication of notes: the highlights themselves plus a **toolbar badge**
  counting the open notes on the current page.
- Per-note actions: **edit**, **resolve**, **move to the other side**, and **delete**.
- **All notes** page (its own tab) listing every commented page, with **remove single**,
  **remove selected**, and **clear all**.
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
