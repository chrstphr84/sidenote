# Changelog

<!-- Generated from changelog.json by tools/gen-changelog.mjs. Do not edit by hand. -->

All notable changes to SideNote are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project aims to follow [Semantic Versioning](https://semver.org/): a **minor**
bump for a feature (or batch of features), a **patch** bump for tweaks and fixes.

## [0.28.0]

### Fixed
- Drawings weren't being saved when “Require saving notes” was turned on: each finished drawing became a draft with no Save button to click, so the next drawing silently replaced it. A completed drawing now always saves, and that setting applies only to notes that open an editor.
- Added a safeguard so a note can never again be left in a state where there's no way to save it.

## [0.27.0]

### Fixed
- Clicking a drawing's note no longer reports “This note's target wasn't found on the page.” Drawings sit at a position on the page rather than on an element, so the note now scrolls to the drawing itself.
- A drawing note's heading showed a truncated “Drawing on” and could hide the note's own buttons — the element name was being inserted as markup instead of text.
- A drawing only follows an element when that element is matched exactly, so it can't jump to an unrelated part of the page.

## [0.26.0]

### Changed
- Closing the sidebar now also puts the drawing palette away.
- Drawings follow the page when it reflows — for example when the sidebar slides open and pushes the content across. Each drawing remembers the element it was drawn over and falls back to its position on the page if that element can't be found, so it still can't disappear.

### Added
- A ⚑ button at the bottom of the sidebar copies diagnostic information to the clipboard, to make reporting a misbehaving page easier.

## [0.25.0]

### Fixed
- The drawing palette now actually disappears when you press Done. It was being hidden in code but stayed painted on screen — visible, unresponsive, still showing tooltips.
- Drawings are visible again after you finish them. The layer they're drawn on had no size, so Chrome clipped everything away.
- Finishing a drawing saves it outright and no longer opens an empty editor, which made a saved note look like it still needed saving. Add text later with the pencil; the tool stays selected so you can keep drawing.

## [0.24.0]

### Fixed
- Drawings no longer disappear the moment you finish them. Each drawing was being attached to whichever element sat under its first pixel, and on pages that constantly update themselves (news sites, feeds, anything with ads) that attachment went stale within milliseconds — so the drawing was immediately reported as “not found on page”. Drawings are now placed on the page itself.
- The note count at the top of the sidebar is accurate again — it was including notes that had been orphaned and hidden.
- The drawing palette dismisses reliably with Done.
- SideNote no longer re-scans the page endlessly when a note can’t be placed, which made everything feel sluggish on busy pages.
- A note whose element genuinely can’t be found keeps its drawing visible instead of vanishing.
- The rainbow swatch now opens the browser’s colour picker.

## [0.23.0]

### Fixed
- Notes and drawings could silently stop saving after the extension was updated while a page stayed open — every later save failed for that page. Saving now recovers on its own, and SideNote tells you to reload the page instead of erroring in the background.
- ⌘Enter / Ctrl+Enter now saves the open note straight after drawing, without having to click the note first.

### Added
- Highlight colour — including a custom colour and an opacity slider — can now be set while you're creating a note, not just afterwards. Opacity is per-note; the Settings value stays the default.
- ⌘B / Ctrl+B and ⌘I / Ctrl+I apply bold and italic in a note.

## [0.22.0]

### Added
- Consolidate notes: Shift+click several notes and choose Consolidate to merge them into one note that points at all of their highlights and drawings. Their text is joined with a plain “---” line you can edit or remove.
- Link notes: Shift+click several and choose Link. Linked notes stay next to each other in the sidebar and in All notes, and each gets a 🔗 button that steps to the next one.
- Consolidating and linking can both be undone with ⌘Z / Ctrl+Z.

### Changed
- A note can now point at several places on a page. Existing notes are upgraded automatically and keep working.

## [0.21.0]

### Added
- ⌘Enter / Ctrl+Enter saves the note you're editing.
- Esc closes the editor (your text is kept), and steps back out of a selection, drawing, or the palette.
- Shift+click notes in the sidebar to select several at once — a bar shows how many are selected.
- When the margin tab is hidden, hold Option (Mac) or Alt (Windows) to reveal it; toggleable in Settings.

### Fixed
- Note text typed just before closing the editor is now always saved.

## [0.20.0]

### Added
- Click a highlight to edit its note. Selecting text that's already highlighted now offers “✏️ Edit note” instead of adding a second note on top of it.
- Drag a drawing to move it somewhere else on the page.
- Custom colour: a rainbow swatch in each note's colour row opens the full colour picker.
- Formatting in notes — bold, italic, and strikethrough, from a small toolbar above the editor. Formatting carries through to Markdown exports.
- A drawing's ink colour now shows in its note's colour swatch, and changing it recolours the drawing.

## [0.19.0]

### Changed
- Drawings and pins now scroll smoothly with the page instead of lagging behind it — they're drawn in page coordinates on a layer the browser scrolls natively, so scrolling no longer repositions them frame by frame.
- Notes in the aligned sidebar reposition more smoothly while scrolling.
- Annotations attached to a sticky or floating header keep tracking it correctly.

### Added
- On pages that draw their content in a canvas (Figma, Miro, map views), SideNote now says up front that annotations can't follow the content when you pan or zoom, instead of silently misplacing them.

## [0.18.0]

### Added
- Highlight opacity setting — highlights are translucent by default so the text underneath stays readable, including light text on dark pages.
- The sidebar title now opens All notes, and the version number at the bottom opens the changelog.

### Fixed
- The drawing palette is reliable again: Done dismisses it, the selected tool stays highlighted, and buttons no longer stop responding on pages that update themselves.
- The drawing tool stays selected after each shape, so you can draw several in a row without re-picking it.
- Note text is saved as you type, so it can't be lost by navigating away or starting another note.

### Changed
- The aligned sidebar layout (notes beside their highlights) is now the default.
- Sidebar footer: the All notes link moved up to the title, and Settings now sits on the panel's outer edge.

## [0.17.0]

### Fixed
- Highlighting text that spans more than one paragraph or element no longer fails — such notes were being orphaned (“text wasn't found on the page”) the instant they were created. SideNote now anchors to the page's own text instead of the browser's selection string, which silently adds line breaks at element boundaries.
- Re-finding highlighted text on a later visit is more tolerant of whitespace and formatting differences.

## [0.16.0]

### Fixed
- Aligned layout: notes whose text scrolls out of view are now hidden instead of piling up at the top and crowding the notes you're looking at. Notes that can't be placed on the page sit in a small stack at the top, clear of the aligned ones.

## [0.15.0]

### Fixed
- A note now saves the moment it's created (even with no text), so starting a new highlight or element link never discards the previous note. Delete any you don't want; turn on “Require saving notes” in Settings for the old save-or-discard behavior.
- Typing a note on sites with single-key keyboard shortcuts (like GitHub) no longer triggers those shortcuts — key presses inside SideNote stay in SideNote.

### Changed
- In the default auto-save mode, a note's editor shows Done / Delete (instead of Save / Cancel), since the note is already saved.

## [0.14.0]

### Added
- Aligned sidebar layout (Settings → Sidebar layout): each note sits next to its highlight or element and follows it as you scroll, like comments in Google Docs. Overlapping notes stack down, and the scrolling list stays the default.

## [0.13.0]

### Changed
- The master switch now means “on everywhere”: with it on, SideNote is available on every site by default, and the popup's “This page” reflects that. Turn a page off individually to opt it out.

### Added
- Settings → “Where SideNote runs”: choose All sites (with a block list) or Only listed sites. Domain patterns support bare domains (covering subdomains) and * wildcards; a per-page toggle always wins.

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

[0.28.0]: #0280
[0.27.0]: #0270
[0.26.0]: #0260
[0.25.0]: #0250
[0.24.0]: #0240
[0.23.0]: #0230
[0.22.0]: #0220
[0.21.0]: #0210
[0.20.0]: #0200
[0.19.0]: #0190
[0.18.0]: #0180
[0.17.0]: #0170
[0.16.0]: #0160
[0.15.0]: #0150
[0.14.0]: #0140
[0.13.0]: #0130
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
