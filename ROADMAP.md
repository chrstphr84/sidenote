# SideNote Roadmap

Planned direction for SideNote, sequenced so foundational decisions land before
the features that depend on them (to avoid uprooting work later). This is a
living document; check it against `CHANGELOG.md` for what has actually shipped.

## Backlog — usage feedback (2026-08-13)

A large batch, sorted into implementation groups. Ordered so foundational/data-model
work lands before the features that depend on it. ✓ = shipped.

### Group A — Critical fixes (legibility + data loss + palette) — ✓ v0.18.0
- **✓ Highlight opacity** — a solid highlight can hide the text under it (worst on dark
  themes with light text). Alpha setting applied to highlight fills.
- **✓ Note text not saved on creation** — typed text (and drawings) could be lost; text now
  autosaves as you type (debounced), not just on explicit save/flush.
- **✓ Palette hardening** — Done didn't dismiss, tool-selected state didn't render, tool
  reset to highlight after each drawing. Single state → render path; tool now persists.
- **✓ Drawing auto-saves on mouse-up and the tool stays armed** so several arrows can be
  drawn in succession without re-selecting the tool each time.

### Group B — Sidebar chrome (quick, low-risk) — ✓ v0.18.0
- **✓ Title ("SideNote") links to All notes**; **✓ remove the bottom "All notes" link**.
- **✓ Settings link moves to the panel's outer edge** (left in the left bar, right in the right).
- **✓ Version number in faint text at the bottom, linking to the changelog.**
- **✓ Aligned layout becomes the default.**

### Group C — Rendering fluidity (architectural) — ✓ v0.19.0
- **✓ Document-coordinate overlay** — annotations now render on `#sn-doc-overlay`
  (`position:absolute` at the document origin, zero-size + `overflow:visible` so it can't
  affect layout or scroll extent). Because an element's rect in *document* space is
  scroll-invariant, scrolling touches nothing: the browser moves the layer natively. The
  old fixed layer (`#sn-overlay`) is kept only for the live drawing preview and for
  anchors inside `fixed`/`sticky` containers, which really do move with the viewport.
- **✓ Aligned cards** positioned with `transform: translateY()` (compositor-friendly)
  instead of `top`, with reads batched before writes.
- **✓ Canvas/zoom apps (Figma, Miro)** — detected (a canvas covering >50% of the viewport)
  and surfaced with an honest one-time message when the palette opens. NOT solvable
  generally: no DOM to anchor to and no observable pan/zoom signal, so we don't pretend to
  track content. Possible future: viewport-anchored ("screen-sticky") notes for these.

### Group D — Editing & interaction — ✓ v0.20.0
- **✓ Click a highlight to edit** its note; selecting already-highlighted text shows
  ✏️ "Edit note" and edits rather than stacking a duplicate note.
- **✓ Drag a drawing to move it** (only when no draw tool is armed, since the capture layer
  owns the pointer then); shapes translate live and commit their new points on release.
- **✓ Drawing ink colour shown in the note's swatch**, and changing it recolours the shapes.
- **✓ Custom colour** — rainbow (conic-gradient) swatch opening the native `<input
  type="color">` picker, with live preview while dragging.
- **✓ Rich text** — bold/italic/strikethrough via a small toolbar. Stored as **Markdown**
  rather than HTML, so it round-trips through the existing Markdown/CSV/plaintext exports
  and rendering stays XSS-safe (escape first, then apply a fixed set of replacements).

### Group E — Keyboard — ✓ v0.21.0
- **✓ Cmd/Ctrl+Enter saves** the focused note or reply.
- **✓ Esc** now steps back through: close the editor (keeping text) → clear a multi-select
  → cancel a re-anchor → cancel a stroke → disarm the tool → close the palette → deselect.
- **✓ Shift+click multi-select** in the sidebar, with a "N selected / Clear" bar.
  `multiSelected` is the hook Group G's consolidation will build on.
- **✓ Option/Alt reveals a hidden tab** while held (Settings toggle
  `revealTabOnModifier`; released on keyup or window blur).

### Group F — Sidebar visibility
- **Auto-hide sidebar** option: reveal on hover-tool/context-menu trigger, auto-hide after
  save with a short, natural delay.

### Group G — Multi-anchor notes — ✓ v0.22.0
- **✓ Data model**: `anchor` → `anchors: []`, with legacy single-anchor notes migrated on
  read (`normalizeComment`). `primaryAnchor()` is the helper for "represent this note".
  Overlay items now carry their own `{anchor, index}`, and shapes are tagged with
  `data-sidenote-anchor` so dragging moves only the drawing you grabbed. A note is orphaned
  only when *none* of its anchors resolve.
- **✓ Consolidate** — Shift+click ≥2 → merge into the oldest note: anchors and replies
  concatenated, bodies joined with a literal `---` line (plain text, so it's editable or
  removable exactly as asked). Undoable.
- **✓ Link** — a shared `linkGroup` id (simpler and better-ordered than pairwise links).
  `orderLinked()` keeps members adjacent in the sidebar and All-notes, and each linked card
  gets a 🔗 that steps to the next member (wrapping). Undoable.
- Chose the **link-icon** option over the connector line: the line is fragile in the aligned
  layout where cards reposition per scroll. Connector line remains possible polish later.

### Group H — Export
- **Export the annotated page as a screenshot alongside the notes** (from All notes).
- **Indicators on page annotations** identifying which comment each belongs to (numbering),
  needed for the screenshot to be readable.
- **PDF export including the image.**

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

## Open: "drawing does not save / first note disappears" (as of v0.27.0)

Confirmed and fixed in v0.27.0 from the same report:
- `gotoHighlight()` always toasted "target wasn't found" for a drawing, because a
  page-anchored region has no element to find. It now scrolls to the shape's own
  page coordinates. (Certain — this is the toast in the screenshot.)
- `anchorHeadHtml()` interpolated the tag inside literal angle brackets
  (`on <${tag}>`), so the tag was parsed as an ELEMENT and injected into the card
  head. Verified: a stray `<div>` inside `.sn-target` before the fix, none after.
  Because `.sn-target` is `overflow:hidden; white-space:nowrap`, anything the
  parser nested there is clipped — the likely cause of "no option to save this
  comment" (the card's controls were invisible).
- Dual anchoring now only trusts an **exact** selector match (`findElementExact`),
  so a fuzzy match can't relocate a drawing to an unrelated element — a plausible
  cause of a drawing appearing to vanish.

STILL not reproduced: a second drawing making the first note disappear. In a
self-mutating-page harness with real mouse input, two successive drawings give 2
notes in storage, 2 sibling cards, 6 painted shape nodes and full controls on both.
Next input needed: the ⚑ diagnostics from a failing page.

## Previously open (v0.26.0)

**Still not reproduced.** Attempted with real mouse input, panel open AND closed,
palette opened from the popup, on a self-mutating page, verified against rendered
pixels: the note saves, the card renders and is visible, and the pencil opens its
editor every time. Since four rounds of guessing have not landed it, v0.26.0 adds a
**⚑ button** in the sidebar footer that copies the live state (settings, counts,
per-note anchors, palette/draw state, orphan count) to the clipboard. Next step is to
read that from a failing page rather than theorise further.

## Resolved from the 2026-08-18 report, part 3 (v0.26.0)

- **Palette now closes with the sidebar** (explicit request).
- **Drawings follow page reflow.** Pushing the page for the sidebar reflows content,
  but page-coordinate drawings stayed put — "the page moves beneath them". Fixed with
  **dual anchoring**: a drawing stores both element-relative shapes (`elShapes` +
  `target`) and page-coordinate shapes. The element form is preferred when it
  resolves, so the drawing travels with the content; page coords remain the fallback
  so a stale element can never make it vanish (the v0.24.0 failure mode).
  `applyPush()` also re-places annotations once the transition has settled.
  Verified: a drawing kept the same 200px offset from its text after the sidebar
  closed and the page reflowed.

## Resolved from the 2026-08-18 report, part 2 (v0.25.0)

Two more real bugs — and both were invisible to the tests I had:

1. **Palette stayed painted after Done.** The shadow CSS sets
   `.sn-palette-bar { display: flex }`, and an **author** `display` declaration
   overrides the UA's `[hidden] { display: none }`. So `el.hidden = true` set the
   attribute (my assertions passed!) while the bar kept rendering — visible,
   inert, tooltips still firing, exactly as reported. Fixed with an explicit
   `[hidden] { display: none !important; }` at the top of the shadow stylesheet,
   which now covers every element. Confirmed against a pre-fix copy: `hidden=true`
   but `display:flex` and a painted 460×44 box.
2. **Drawings clipped away.** `#sn-doc-overlay` was `width:0; height:0` relying on
   `overflow: visible`; Chrome still clips an outer `<svg>` sized 0×0, so
   page-coordinate shapes were painted nowhere. The layer is now sized to the
   document scroll size (never larger, so it can't extend the page).
3. **"Drawings don't save"** was a UX signal, not a data bug: finishing a drawing
   opened an empty editor, so a saved note looked pending. Drawings now save
   silently (`createNote(..., { edit: false })`); text can be added later.

**Testing rule learned (the important part):** asserting `.hidden`, computed state,
or node presence is NOT sufficient — all three of these passed while the product was
visibly broken. Drawing/palette changes must be verified against **rendered pixels**
(screenshot + colour sampling) with **real mouse input** on a **self-mutating page**.

## Resolved from the 2026-08-18 report (v0.24.0)

Root cause found: **drawings were anchored to the element under their first pixel**.
`cssPathOf` produces a structural `:nth-of-type()` path; on pages that inject/remove
nodes constantly (NYT, feeds, ads) that path goes stale within milliseconds, and the
fuzzy fallback can't rescue an anonymous `<div>` (score < 3). The note was therefore
orphaned the instant it was created → the drawing vanished on mouse-up, the header
count included hidden orphans, and the orphan-driven MutationObserver then re-anchored
**forever** on a mutating page, starving the UI (which is why the palette felt dead).

Fixes: drawings are now **page-anchored** (they never need an element, and the v0.19
document-coordinate layer already makes page coords scroll natively); a region whose
element is missing **falls back to page coords instead of orphaning**; the re-anchor
observer now has a **budget** instead of retrying indefinitely; and the rainbow swatch
hosts a real (transparent, full-size) `<input type="color">` so Chrome actually opens
its native picker.

Testing lesson: synthetic `MouseEvent` dispatch on a trivial DOM passed while the real
thing failed. These were reproduced only with **real Playwright mouse input on a
self-mutating page** — that combination is now the bar for drawing/palette changes.

## Previously open from the 2026-08-18 report

- **Drawings vanish on mouse-up / palette "Done" does nothing** — could NOT be reproduced
  in a clean context (both pass). Strongly correlated with the "Extension context
  invalidated" errors: a content script orphaned by an extension reload lost chrome.* and
  poisoned the write chain (fixed in v0.23.0). **Re-test on freshly reloaded tabs**; if it
  still happens there, capture the console output at the moment of the failed mouse-up.
- **Default mode = text highlighting** — already the behaviour (closing the palette clears
  the armed tool, and "Select" disarms without closing). Confirm after the v0.23.0 fixes.
- Still queued: Group F (auto-hide sidebar), Group H (screenshot/PDF export with
  per-annotation indicators).
