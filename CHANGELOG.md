# Changelog

<!-- Generated from changelog.json by tools/gen-changelog.mjs. Do not edit by hand. -->

All notable changes to SideNote are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project aims to follow [Semantic Versioning](https://semver.org/): a **minor**
bump for a feature (or batch of features), a **patch** bump for tweaks and fixes.

## [0.12.0]

### Added
- Notes now appear on load without needing a reload — SideNote keeps trying to place them as the page finishes loading or lazily adds content.
- A “Require saving notes” option (Settings → Adding notes). Off by default, so a new note is kept even if you don't type anything (a highlight or element link can be enough); turn it on to require Save.

### Changed
- Starting a new note now keeps the previous one (saved even if empty) instead of discarding it, unless “Require saving notes” is on.
- “Move to other side” only appears when the margin is set to Both.

### Removed
- The “Clear all” button on the All notes page — use Select all + Remove selected.

## [0.11.0]

### Added
- Re-anchor notes that couldn't be placed: click “Re-anchor to new text” on the note and select the new spot on the page.
- A banner in the margin shows how many notes couldn't be placed on the current page (the text or element may have changed).
- “Check links” on the All notes page marks each page as Reachable, Not found, Sign-in required, or Unreachable — best-effort, and nothing is ever deleted automatically.

### Changed
- Text notes now re-find their spot more reliably when only the whitespace or minor formatting changed.

## [0.10.0]

### Added
- Undo (⌘Z / Ctrl+Z, or the ↶ button in the drawing palette) for adding and deleting notes — undoing right after a drawing removes it.
- Click a drawing or an element's pin on the page to select it, then delete just that piece with the floating Delete button or the Delete key.

### Changed
- Moved the Draw button to the top of the margin (the panel header).
- The drawing palette is easier to dismiss: a clear Done button plus Esc (which first cancels an in-progress stroke, then disarms the tool, then closes the palette); hardened the teardown so it can't get stuck.

## [0.9.0]

### Added
- Link an element precisely from DevTools: open DevTools → Elements, select an element, and use the SideNote sidebar pane to attach a note to it — ideal for tiny or custom controls that are hard to right-click.

### Fixed
- Right-clicking a custom control (e.g. a checkbox drawn with an SVG icon) now attaches the note to the control or its label instead of an inner shape.
- Element notes re-find their target far more reliably — including SVG-based elements — so they no longer show “not found on page” after a reload.

## [0.8.0]

### Added
- Export your notes straight into a Google Doc or Google Sheet from the All notes page.
- Google export uses your own Google OAuth client — set the client ID (and copy the redirect URI) from Settings → Google export; SideNote only requests permission to create files it makes.

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

[0.12.0]: #0120
[0.11.0]: #0110
[0.10.0]: #0100
[0.9.0]: #090
[0.8.0]: #080
[0.7.0]: #070
[0.6.0]: #060
[0.5.0]: #050
[0.4.0]: #040
[0.3.0]: #030
[0.2.1]: #021
[0.2.0]: #020
[0.1.0]: #010
