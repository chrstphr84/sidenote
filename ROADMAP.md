# SideNote Roadmap

Planned direction for SideNote, sequenced so foundational decisions land before
the features that depend on them (to avoid uprooting work later). This is a
living document; check it against `CHANGELOG.md` for what has actually shipped.

## Backlog — usage feedback (2026-07-26)

Grouped and roughly ordered. Small/clear items marked ✓ shipped in v0.12.0.

### Fixes
- **✓ Text re-anchoring across elements (v0.17.0)** — multi-paragraph/multi-node selections
  were orphaned on creation because the anchor stored `Selection.toString()` (which injects
  whitespace at element boundaries) while re-anchoring searches SideNote's own text-node
  concatenation. Now the anchor is derived from that same concatenation; plus a
  whitespace-stripping re-anchor fallback tolerates separator/formatting changes on reload.
- **✓ Notes save on creation (v0.15.0)** — a note persists the instant it's created (even
  empty); creating a new anchor flushes the current note's text first, so nothing is lost.
  Auto-save is default; `requireExplicitSave` restores Save-or-discard.
- **✓ Page keyboard-shortcut conflict (v0.15.0)** — key events typed inside SideNote are
  stopped at the shadow boundary (bubble phase), so sites with single-key hotkeys (GitHub)
  don't act on them; our own shortcuts use document capture and still fire.
- **Aligned layout** — verified working in tests (cards track anchors). If it appears not to
  work, confirm the extension is reloaded (v0.14.0+) and Settings → Sidebar layout → Aligned.
- **✓ Auto-show notes on load (v0.12.0)** — text highlights and drawings sometimes needed a
  reload/click to appear (element outlines were reliable). Fixed with timed initial render
  passes + a debounced MutationObserver that re-anchors when the DOM changes while notes are
  unplaced (guarded against our own span mutations).
- **DevTools element selection still not working** — the Elements-panel "SideNote" sidebar
  pane exists but the user can't select an element there. Needs live debugging: confirm the
  pane appears, that `$0` is available to `inspectedWindow.eval`, and the background→content
  relay fires. Consider an alternative (inspect + keyboard command). Can't verify headless.

### Sidebar behavior
- **✓ Save empty notes by default (v0.12.0)** — starting a new note now commits the previous
  one even if it has no text (a highlight/link alone can be enough). New `requireExplicitSave`
  setting (default off) restores the Save-or-discard behavior.
- **✓ Disable "move to other side" unless "both" is enabled (v0.12.0).**
- **Reorder notes in the sidebar via drag-and-drop** — needs an explicit order field on notes
  (currently implicit by array order); moderate.

### Larger features
- **✓ Aligned/scrolling sidebar (v0.14.0)** — optional layout (Settings → Sidebar layout)
  where each card is absolutely positioned at its anchor's viewport Y (panel-relative),
  tracks it on scroll, and collision-pushes overlapping cards down; list stays the default.
  v0.16.0: cards for off-screen anchors are now hidden (not piled) so scrolling doesn't
  crowd the visible notes; orphaned notes sit in a contained top stack. Still no connector
  lines or focus-shift-to-anchor (possible polish later).

### Settings / All-notes
- **✓ Remove the "Clear all" button (v0.12.0)** — redundant with Select all + Remove.
- **Filter / group / select by domain on the All-notes page** — group pages under their
  domain, filter to one domain, select-all-in-domain. Moderate.

### Enablement model (extension popup + settings) — DONE (v0.13.0)
- **✓ Master = "on everywhere by default"** — `isPageEnabled` now returns true by default
  when master is on (subject to domain rules); a per-page toggle overrides either way. The
  DOM observer is gated to pages that actually have notes to keep the now-many enabled-empty
  pages cheap.
- **✓ Per-domain allow/deny (Settings → "Where SideNote runs")** — "All sites" (block list)
  or "Only listed sites" (allow list); patterns cover subdomains and `*` wildcards.

## The pivotal decision: a generalized anchor model

Through v0.2.x a note can only anchor to **text**
(`anchor = {exact, prefix, suffix, index}`). Element linking, drawing, and
faithful export can't be expressed in that shape, so the anchor is being
generalized to a typed union **before** those features are built:

```
anchor.type = "text"     // exact/prefix/suffix/index          → highlight span
            | "element"   // robust element locator             → pin/outline, no highlight
            | "region"    // element-or-page + shapes[]         → SVG drawing overlay
```

Element locators follow the same resilience philosophy as the text anchor: store
several signals (CSS path + id/tag/classes + alt/aria/text hint + nth-of-type)
and score them on re-find, so buttons/images survive minor DOM changes the way
quotes survive text shifts.

Two supporting refactors ride along:

1. **Render dispatcher** — `renderAnnotations()` branches by `anchor.type`
   (span / pin / SVG) instead of a text-only path.
2. **Unified `createNote(anchor, …)` pipeline** — every trigger (hover button,
   right-click menu, keyboard shortcut, draw tool) funnels through one path, so
   toggling a trigger on/off is a settings flag, not forked logic.

## Phases

### Phase 0 — Foundation + quick wins
- Generalized anchor union + normalization (migrate existing text notes to `type:"text"`).
- Render dispatcher and an SVG overlay layer (tracks scroll/resize).
- Unified `createNote()` creation pipeline.
- Quick wins that also exercise the dispatcher: hover-emphasis (card ↔ target) and resolved-note strikethrough.

### Phase 1 — Element linking + triggers
- Link a note to a button/image/element with a pin (no highlight required).
- Right-click context-menu add ("Add SideNote" / "Link this element"); optional in settings.
- User-defined keyboard shortcut.
- Hover tool becomes optional; constraint: at least one add-method always enabled.
- New permissions: `contextMenus`, and `commands` (or content-script key capture).

### Phase 2 — Margin tab control
- Reposition the speech-bubble tab vertically; option to hide it (relies on Phase 1's shortcut/context-menu as an alternate open).
- Custom highlight color / expanded palette polish.

### Phase 3 — Drawing tools — DONE (v0.6.0)
- Tool palette: select / draw (rectangle, ellipse, line, arrow, freehand) with ink colors.
- Built on the Phase 0 overlay + `region` anchor; drawings anchor to the element beneath
  them (or the page) and open a note card for a comment.

### Phase 4 — Export — DONE (v0.7.0 / v0.8.0)
- Markdown / CSV / plaintext (pure client-side transforms over the note model) — DONE (v0.7.0).
- PDF (styled print view) — DONE (v0.7.0).
- Google Docs / Sheets — IMPLEMENTED (v0.8.0), pending live verification with a real
  OAuth client. Uses `chrome.identity.launchWebAuthFlow` (implicit flow, user supplies
  their own OAuth client ID in Settings — no secret in the repo) + the `drive.file` scope,
  and reuses the existing HTML/CSV transforms via Drive's import conversion
  (HTML → Doc, CSV → Sheet).

### Phase 4+ — Export enhancements (later)
- **Page screenshot in the export** — capture the page (or the region around each note)
  and embed it in the Doc/PDF export. Likely via `chrome.tabs.captureVisibleTab` (needs
  `activeTab`/`<all_urls>`) and/or the region overlay; investigate resolution + which
  export formats can embed images (HTML/Doc/PDF can; Markdown via data URI; CSV can't).

### Phase 5 — Drawing palette polish — DONE (v0.10.0)
- **Dismiss reliability** — DONE. A clear Done button + progressive Esc (cancel stroke →
  disarm tool → close), and closePalette now tears down any in-progress stroke/listeners
  so it can't get stuck. (No firm repro of the original bug, but the teardown is hardened.)
- **Palette entry point near the top** — DONE. The Draw trigger moved to the panel header.
- **Undo** — DONE. Undo stack for add/delete, with a ↶ button in the palette.
- **Standard undo key** — DONE. Cmd/Ctrl+Z, ignored while typing in a field.
- **Select a piece to delete** — DONE. Click a drawing/pin to select it (highlight +
  floating Delete button, or the Delete key). Each drawing is its own note, so this
  removes exactly that piece; undo restores it. (Multi-shape single notes remain a future
  option if we ever group shapes into one note.)

### Element linking precision — DONE (v0.9.0)
- Custom controls (e.g. an SVG-drawn checkbox) now climb to the nearest control/label on
  right-click, and element locators use a structural CSS path that matches SVG-namespaced
  elements (the old positional XPath silently failed on SVG, causing "not found on page").
- **DevTools element selection**: an Elements-panel sidebar pane links the exact selected
  element (`$0`) — for precise/awkward targets — without removing right-click linking.
- Known limitation: linking hover-only **tooltips** is still hard, since the tooltip DOM
  is removed when the mouse moves to interact with it. DevTools selection helps when the
  element can be pinned in the Elements tree; otherwise largely unavoidable.

### Cross-cutting — Error handling — DONE (v0.11.0)
- "Page changed": DONE. Whitespace-normalized re-anchoring fallback, an orphan-count
  banner in the margin, and a per-note "Re-anchor to new text" affordance (select the new
  spot; the anchor updates). Element/drawing notes prompt to right-click/re-link.
- "Page no longer exists" (404): DONE. "Check links" on the All-notes page probes each
  page and labels it Reachable / Not found / Sign-in required / Unreachable. Best-effort
  (cross-origin auth walls and HEAD-blocking servers are labeled distinctly, not deleted);
  nothing is ever removed automatically. Note snippets keep value without the live page.
- Possible follow-ups: element/drawing re-link UI (currently delete + re-add), and an
  optional auto-check on the All-notes page.

### Cross-cutting — Play nicely with a top-docked bar (e.g. Colorbars) — DONE (v0.5.0)
Shipped. Another extension of ours, **Colorbars**, overlays a fixed bar
at the top of the page (`#__domain_top_bar__`, `top:0`) that can obscure the top of
SideNote's margin panel (title + badge). Because content scripts share the DOM (even
across extensions/isolated worlds), SideNote can:
- Measure the bar's height directly from the DOM and apply it as a **top inset** to the
  fixed panels (and the FAB's vertical range).
- React to changes with a `MutationObserver` (bar added/removed) + `ResizeObserver`
  (height/setting changes) — including Colorbars being disabled (element vanishes →
  inset returns to 0).
- Generalize to "any top-docked fixed bar" so it degrades gracefully for other tools.
No coupling to Colorbars' storage or code; the user never sees that SideNote is aware
of it. Do this whenever the margin's top edge needs to stop fighting a top bar.

## Status of the original wishlist

| Idea | Phase | Status entering Phase 0 |
| --- | --- | --- |
| Multiple highlight colors | 2 (polish) | Mostly done (per-note palette, v0.2.0) |
| Hover note → emphasize target | 0 | Partial (CSS hooks; wiring pending) |
| Resolved notes strikethrough + delete from margin | 0 | Partial (resolve + delete exist; restyle pending) |
| Error handling: page changed | X-cutting | Done (v0.11.0: fuzzy re-anchor + manual re-anchor) |
| Link directly to elements | 1 | Done (v0.4.0); precision hardened + DevTools pick (v0.9.0) |
| Highlight/select/draw palette | 3 | Done (v0.6.0) |
| Contextual menu add | 1 | Done (v0.4.0) |
| User keyboard shortcut | 1 | Done (v0.4.0) |
| Move / hide the margin tab | 2 | Done (v0.5.0) |
| Exports (MD/CSV/plaintext/PDF/Google) | 4 | MD/CSV/txt/PDF done (v0.7.0); Google implemented (v0.8.0, pending live verify) |
| Screenshot in export | 4+ | New |
| Drawing palette polish (dismiss/undo/select-shape/top entry) | 5 | Done (v0.10.0) |
| Error handling: page 404 | X-cutting | Done (v0.11.0: All-notes link check) |
