# SideNote Roadmap

Planned direction for SideNote, sequenced so foundational decisions land before
the features that depend on them (to avoid uprooting work later). This is a
living document; check it against `CHANGELOG.md` for what has actually shipped.

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

### Phase 3 — Drawing tools
- Tool palette: highlight / select / draw (rectangle, ellipse, line, arrow, freehand).
- Built on the Phase 0 overlay + `region` anchor.

### Phase 4 — Export
- Markdown / CSV / plaintext (pure client-side transforms over the note model).
- PDF (styled print view).
- Google Docs / Sheets (needs `identity` + OAuth scopes; heaviest, gated last).

### Cross-cutting — Error handling
- "Page changed": baseline exists (orphaned notes preserved + flagged "not found on page"); improve fuzzy re-anchoring and a manual re-anchor affordance.
- "Page no longer exists" (404): lazy "unreachable" status on the All-notes page; note snippets already give value without the live page.

## Status of the original wishlist

| Idea | Phase | Status entering Phase 0 |
| --- | --- | --- |
| Multiple highlight colors | 2 (polish) | Mostly done (per-note palette, v0.2.0) |
| Hover note → emphasize target | 0 | Partial (CSS hooks; wiring pending) |
| Resolved notes strikethrough + delete from margin | 0 | Partial (resolve + delete exist; restyle pending) |
| Error handling: page changed | X-cutting | Baseline (orphan flagging) |
| Link directly to elements | 1 | New (needs anchor union) |
| Highlight/select/draw palette | 3 | New (needs overlay) |
| Contextual menu add | 1 | New |
| User keyboard shortcut | 1 | New |
| Move / hide the margin tab | 2 | New |
| Exports (MD/CSV/plaintext/PDF/Google) | 4 | New |
| Error handling: page 404 | X-cutting | New |
