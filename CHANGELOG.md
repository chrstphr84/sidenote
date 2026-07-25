# Changelog

<!-- Generated from changelog.json by tools/gen-changelog.mjs. Do not edit by hand. -->

All notable changes to SideNote are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project aims to follow [Semantic Versioning](https://semver.org/): a **minor**
bump for a feature (or batch of features), a **patch** bump for tweaks and fixes.

## [0.7.0]

### Added
- Export your notes from the All notes page as Markdown, plain text, CSV, or PDF (via a print view).
- Export every page at once, or select specific pages and export just those.

### Fixed
- The All notes page no longer errors on element-linked or drawing notes — it shows a short descriptor instead of a text quote.

## [0.6.0]

### Added
- Drawing tools: a floating palette to draw rectangles, ellipses, lines, arrows, and freehand strokes over the page — each drawing becomes a note you can comment on.
- Pick an ink color for drawings; the last color is remembered.
- Drawings anchor to the element beneath them (or to the page) so they move with the content and come back on reload.
- Open the palette from a note panel's Draw button or the toolbar's “Draw on page”; press Escape to cancel a stroke or leave drawing mode.

## [0.5.0]

### Added
- Drag the margin tab up or down to reposition it; its position is remembered.
- Setting to hide the margin tab entirely — open the margin from the toolbar popup or by clicking a highlight or pin.
- The margin now tucks below a bar added at the top of the page by another extension (such as Colorbars), and re-adjusts automatically when that bar changes height or is turned off.

## [0.4.0]

### Added
- Link a note to any element — a button, image, or link — from the right-click menu. The element is marked with a pin and outline instead of a text highlight.
- Right-click “Add SideNote to selection” to add a note without the floating button.
- Keyboard shortcut (Alt+Shift+N by default) to add a note from the selected text; rebind it at chrome://extensions/shortcuts.
- Settings to turn the selection button, right-click menu, and keyboard shortcut on or off — at least one of the selection button or right-click menu always stays on.

### Fixed
- Newly highlighted text now appears immediately instead of only after reloading the page.

## [0.3.0]

### Added
- Hovering a note now emphasizes its linked text on the page — and hovering highlighted text emphasizes its note in the margin.
- Groundwork for linking notes to page elements (buttons, images) and for freehand drawings, arriving in upcoming releases.

### Changed
- Resolved notes now show a strikethrough (on both the note and its highlight) instead of a dotted underline; they remain in the margin and can still be deleted.

## [0.2.1]

### Changed
- Single-page-app navigation is now detected with the Navigation API (event-driven) instead of polling, with a popstate + poll fallback on older Chrome.

## [0.2.0]

### Added
- Threaded replies: reply to a note, and edit or delete individual replies. Reply counts show on the All-notes page.
- Per-note highlight color: pick from a palette on each note; the on-page highlight updates to match.
- Single-page-app support: when a site changes the page without a full reload, SideNote re-keys to the new page's notes automatically.

## [0.1.0]

### Added
- Proof of concept: attach comments to highlighted text on any web page, shown in a margin like Google Docs.
- Per-page on/off from the toolbar popup, plus a master switch across all pages.
- Margin can sit on the left, right, or both sides; set the default in Settings or per page from the popup.
- Open and close the margin from a tab on the page edge without losing any notes.
- Notes persist in local storage keyed by page, so they return after closing the tab or window.
- Highlights re-anchor to their text on reload using the surrounding context, and notes whose text is gone are flagged rather than lost.
- On-page indication: highlighted text plus a toolbar badge counting open notes.
- Per-note actions: edit, resolve, move to the other side, and delete.
- All-notes page (opens in its own tab) listing every commented page, with remove single, remove selected, and clear all.
- Settings page (opens in its own tab) with Light / Dark / Auto theme, default margin side, highlight color, and margin width, styled to match Colorbars.
- In-extension Help and Changelog pages.

[0.7.0]: #070
[0.6.0]: #060
[0.5.0]: #050
[0.4.0]: #040
[0.3.0]: #030
[0.2.1]: #021
[0.2.0]: #020
[0.1.0]: #010
