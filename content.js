// SideNote content script — the on-page experience.
//
// Responsibilities:
//   * Anchor comments to page text (quote + surrounding context) so highlights
//     survive a reload even though the DOM is regenerated.
//   * Wrap commented text in highlight <span>s (the on-page indication).
//   * Render a margin ("panel") on the left, right, or both sides inside an
//     isolated shadow root, so page CSS can't distort it.
//   * Show an "Add note" affordance when text is selected.
//
// Notes persist in chrome.storage.local keyed by the page (see shared.js), so
// closing the tab and coming back restores everything.

(() => {
  const HOST_ID = "__sidenote_root__";
  let PAGE_KEY = pageKeyFromHref(location.href);

  // Browser-internal / unsupported pages: do nothing.
  if (!PAGE_KEY || !isSupportedPageUrl(location.href)) return;
  // Guard against double-injection.
  if (window.__sidenoteInjected) return;
  window.__sidenoteInjected = true;

  /* ------------------------------------------------------------- State */
  let settings = { ...DEFAULT_SETTINGS };
  let entry = null; // this page's stored entry (or null)
  let comments = []; // persisted comments for this page
  let draft = null; // in-progress new comment (not yet persisted)
  let replyDraft = null; // in-progress reply: { commentId, reply }
  let editingId = null; // id of the comment/reply currently being edited
  let colorPickerId = null; // id of the comment whose color palette is open
  let reanchorId = null; // id of a text note being manually re-anchored
  let active = false; // is SideNote live on this page?
  const open = { left: false, right: false }; // which panels are expanded

  // Drawing (Phase 3)
  let paletteOpen = false; // the drawing tool palette is shown
  let drawTool = null; // "rect" | "ellipse" | "line" | "arrow" | "freehand" | null
  let drawing = null; // in-progress stroke: { kind, points: [{x,y}] } in viewport coords
  const undoStack = []; // recent reversible actions: { kind:"add", id } | { kind:"remove", comment }
  let selectedNoteId = null; // an on-page drawing/pin selected for deletion

  let hostEl = null;
  let shadow = null;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

  /* --------------------------------------------------- Text anchoring */
  // Build a flat map of the page's visible text: the concatenated string plus,
  // for each contributing text node, the [start,end) range it occupies.
  function buildTextMap() {
    const nodes = [];
    let text = "";
    const body = document.body;
    if (!body) return { text, nodes };
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.closest && p.closest(`#${HOST_ID}`)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const start = text.length;
      text += node.nodeValue;
      nodes.push({ node, start, end: text.length });
    }
    return { text, nodes };
  }

  function globalOffsetOf(map, container, offset) {
    if (container && container.nodeType === Node.TEXT_NODE) {
      const seg = map.nodes.find((s) => s.node === container);
      if (seg) return seg.start + offset;
    }
    return null;
  }

  function countOccurrencesBefore(full, needle, pos) {
    if (!needle) return 0;
    let count = 0;
    let i = full.indexOf(needle);
    while (i !== -1 && i < pos) {
      count += 1;
      i = full.indexOf(needle, i + 1);
    }
    return count;
  }

  // Capture an anchor from the live selection.
  function anchorFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const exact = sel.toString();
    if (!exact.trim()) return null;

    const range = sel.getRangeAt(0);
    const map = buildTextMap();
    let startG = globalOffsetOf(map, range.startContainer, range.startOffset);
    let endG = globalOffsetOf(map, range.endContainer, range.endOffset);

    // Fall back to a plain text search when the selection boundaries aren't
    // clean text nodes (e.g. they land on element edges).
    if (startG == null || endG == null || endG <= startG) {
      const found = map.text.indexOf(exact);
      if (found === -1) return { type: "text", exact, prefix: "", suffix: "", index: 0 };
      startG = found;
      endG = found + exact.length;
    }

    return {
      type: "text",
      exact,
      prefix: map.text.slice(Math.max(0, startG - 40), startG),
      suffix: map.text.slice(endG, endG + 40),
      index: countOccurrencesBefore(map.text, exact, startG)
    };
  }

  function locate(map, g, isEnd) {
    for (const seg of map.nodes) {
      if (isEnd ? g > seg.start && g <= seg.end : g >= seg.start && g < seg.end) {
        return { node: seg.node, offset: g - seg.start };
      }
    }
    // Boundary at the very end of the text.
    const last = map.nodes[map.nodes.length - 1];
    if (last && g === last.end) return { node: last.node, offset: last.node.nodeValue.length };
    return null;
  }

  // Collapse whitespace runs to single spaces, keeping a map from each collapsed
  // index back to the original index — used to re-anchor across formatting changes.
  function collapseWhitespace(text) {
    let out = "";
    const idx = [];
    let prevSpace = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        if (prevSpace) continue;
        out += " ";
        idx.push(i);
        prevSpace = true;
      } else {
        out += ch;
        idx.push(i);
        prevSpace = false;
      }
    }
    return { text: out, idx };
  }

  function rangeFromRawOffsets(map, rawStart, rawEnd) {
    const s = locate(map, rawStart, false);
    const e = locate(map, rawEnd, true);
    if (!s || !e) return null;
    try {
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      return range;
    } catch (_) {
      return null;
    }
  }

  // Fallback for when the exact string no longer matches (e.g. whitespace or
  // minor formatting changed): search on a whitespace-collapsed copy.
  function findRangeNormalized(map, anchor) {
    const cFull = collapseWhitespace(map.text);
    const cExact = collapseWhitespace(anchor.exact).text.trim();
    if (cExact.length < 3) return null;
    const at = cFull.text.indexOf(cExact);
    if (at === -1) return null;
    const rawStart = cFull.idx[at];
    const rawEnd = cFull.idx[at + cExact.length - 1] + 1;
    return rangeFromRawOffsets(map, rawStart, rawEnd);
  }

  // Re-find the range for an anchor in the current DOM.
  function findRange(anchor) {
    if (!anchor || !anchor.exact) return null;
    const map = buildTextMap();
    const full = map.text;
    const positions = [];
    let i = full.indexOf(anchor.exact);
    while (i !== -1) {
      positions.push(i);
      i = full.indexOf(anchor.exact, i + 1);
    }
    if (positions.length === 0) return findRangeNormalized(map, anchor);

    let best = positions[0];
    let bestScore = -1;
    positions.forEach((pos, idx) => {
      let score = 0;
      const pre = full.slice(Math.max(0, pos - anchor.prefix.length), pos);
      const suf = full.slice(pos + anchor.exact.length, pos + anchor.exact.length + anchor.suffix.length);
      if (anchor.prefix && pre.endsWith(anchor.prefix)) score += 2;
      if (anchor.suffix && suf.startsWith(anchor.suffix)) score += 2;
      if (idx === anchor.index) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = pos;
      }
    });

    const startLoc = locate(map, best, false);
    const endLoc = locate(map, best + anchor.exact.length, true);
    if (!startLoc || !endLoc) return null;
    try {
      const range = document.createRange();
      range.setStart(startLoc.node, startLoc.offset);
      range.setEnd(endLoc.node, endLoc.offset);
      return range;
    } catch (_) {
      return null;
    }
  }

  /* ------------------------------------------------------- Highlights */
  function highlightRange(range, comment) {
    if (!range || range.collapsed) return [];
    const root = range.commonAncestorContainer;
    const textNodes = [];
    if (root.nodeType === Node.TEXT_NODE) {
      textNodes.push(root);
    } else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          return range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let n;
      while ((n = walker.nextNode())) textNodes.push(n);
    }

    const spans = [];
    textNodes.forEach((node) => {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      if (start >= end) return;
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, end);
      const span = document.createElement("span");
      span.className = "__sidenote_hl";
      span.setAttribute("data-sidenote-id", comment.id);
      const color = comment.color || settings.highlightColor;
      span.style.setProperty("background-color", color, "important");
      if (comment.resolved) span.classList.add("__sidenote_hl_resolved");
      try {
        r.surroundContents(span);
        spans.push(span);
      } catch (_) {
        /* range crossed an element boundary awkwardly — skip this fragment */
      }
    });
    return spans;
  }

  function unwrap(span) {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }

  function unwrapAll() {
    document.querySelectorAll(".__sidenote_hl").forEach(unwrap);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  /* --------------------------------------------------- Element anchors */
  // A structural CSS selector path. Unlike positional XPath, CSS selectors match
  // SVG-namespaced elements (svg/rect/path) via querySelector, which is exactly
  // what custom checkboxes/icons are built from. Anchors at the nearest unique
  // id when there is one.
  function cssPathOf(el) {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const tag = (node.tagName || "").toLowerCase();
      if (!tag || tag === "html") break;
      if (node.id) {
        const byId = `#${cssEscape(node.id)}`;
        try {
          if (document.querySelectorAll(byId).length === 1) {
            parts.unshift(byId);
            break;
          }
        } catch (_) {
          /* invalid id */
        }
      }
      let seg = tag.includes(":") ? `*|${tag}` : tag;
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = parent;
    }
    return parts.join(" > ");
  }

  function attrHintOf(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      (el.tagName === "INPUT" ? el.getAttribute("type") || "input" : "") ||
      ""
    );
  }

  function buildTarget(el) {
    const rect = el.getBoundingClientRect();
    const nth = el.tagName ? Array.from(document.getElementsByTagName(el.tagName)).indexOf(el) : 0;
    return {
      selector: cssPathOf(el),
      xpath: "",
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      role: el.getAttribute("role") || "",
      classes: Array.from(el.classList || []),
      textHint: (el.textContent || "").trim().slice(0, 60),
      attrHint: attrHintOf(el),
      nthOfType: Math.max(0, nth),
      rect: { w: Math.round(rect.width), h: Math.round(rect.height) }
    };
  }

  // Re-find a linked element: exact structural selector first, then a scored
  // fuzzy fallback for pages that reflowed.
  function findElement(target) {
    if (!target) return null;
    if (target.selector) {
      try {
        const bySel = document.querySelector(target.selector);
        if (bySel && !(bySel.closest && bySel.closest(`#${HOST_ID}`))) return bySel;
      } catch (_) {
        /* invalid selector */
      }
    }
    // Fuzzy fallback: score every element of the same tag.
    const candidates = target.tag ? Array.from(document.getElementsByTagName(target.tag)) : [];
    let best = null;
    let bestScore = 0;
    candidates.forEach((el) => {
      if (el.closest && el.closest(`#${HOST_ID}`)) return;
      let score = 0;
      if (target.id && el.id === target.id) score += 5;
      if (target.textHint && (el.textContent || "").trim().slice(0, 60) === target.textHint) score += 3;
      if (target.attrHint && attrHintOf(el) === target.attrHint) score += 3;
      if (target.role && el.getAttribute("role") === target.role) score += 1;
      const cls = Array.from(el.classList || []);
      const shared = (target.classes || []).filter((c) => cls.includes(c)).length;
      score += Math.min(shared, 2);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return bestScore >= 3 ? best : null;
  }

  /* ------------------------------------------------------- SVG overlay */
  // Pins (element notes) and drawings (region notes) live in a fixed, isolated
  // SVG layer in the shadow root; positions are recomputed from live element
  // rects on scroll/resize.
  const overlayItems = []; // { comment, el|null }

  function overlayEl() {
    return shadow ? shadow.getElementById("sn-overlay") : null;
  }

  function clearOverlay() {
    overlayItems.length = 0;
    const svg = overlayEl();
    if (svg) svg.innerHTML = "";
  }

  function svgNode(name, attrs) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
    return n;
  }

  function renderPin(comment, el) {
    overlayItems.push({ comment, el });
  }

  function renderRegion(comment) {
    const el = comment.anchor.relativeTo === "element" ? findElement(comment.anchor.target) : null;
    if (comment.anchor.relativeTo === "element" && !el) return false;
    overlayItems.push({ comment, el });
    return true;
  }

  // Draw/position every overlay item from current geometry.
  function drawOverlay() {
    const svg = overlayEl();
    if (!svg) return;
    svg.innerHTML = "";
    overlayItems.forEach(({ comment, el }) => {
      const color = comment.color || settings.highlightColor;
      if (comment.anchor.type === "element" && el) {
        const r = el.getBoundingClientRect();
        const box = svgNode("rect", {
          x: r.left - 2, y: r.top - 2, width: r.width + 4, height: r.height + 4,
          rx: 4, fill: "none", stroke: color, "stroke-width": 2,
          "stroke-dasharray": comment.resolved ? "4 3" : "0",
          class: "sn-ov-outline", "data-sidenote-id": comment.id
        });
        const pin = svgNode("circle", {
          cx: r.right, cy: r.top, r: 9, fill: color, stroke: "#fff", "stroke-width": 2,
          class: "sn-ov-pin", "data-sidenote-id": comment.id
        });
        svg.appendChild(box);
        svg.appendChild(pin);
      } else if (comment.anchor.type === "region") {
        // Element-relative: track the element's live rect. Page-relative: points
        // are page coords, so shift by the negative scroll to place them on the
        // fixed overlay (and they follow the page as it scrolls).
        const origin = el
          ? el.getBoundingClientRect()
          : { left: -window.scrollX, top: -window.scrollY };
        (comment.anchor.shapes || []).forEach((shape) => drawShape(svg, comment, shape, origin));
      }
    });
    // Re-apply the on-page selection emphasis after a redraw (scroll/resize).
    if (selectedNoteId) {
      svg.querySelectorAll(`[data-sidenote-id="${cssEscape(selectedNoteId)}"]`).forEach((n) => n.classList.add("sn-ov-selected"));
    }
  }

  function drawShape(svg, comment, shape, origin) {
    const pts = shape.points.map((p) => ({ x: p.x + origin.left, y: p.y + origin.top }));
    const common = {
      fill: "none", stroke: shape.color, "stroke-width": shape.width,
      "stroke-linecap": "round", "stroke-linejoin": "round",
      class: "sn-ov-shape", "data-sidenote-id": comment.id
    };
    if (shape.kind === "rect" && pts.length >= 2) {
      const [a, b] = pts;
      svg.appendChild(svgNode("rect", { ...common, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }));
    } else if (shape.kind === "ellipse" && pts.length >= 2) {
      const [a, b] = pts;
      svg.appendChild(svgNode("ellipse", { ...common, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, rx: Math.abs(b.x - a.x) / 2, ry: Math.abs(b.y - a.y) / 2 }));
    } else if ((shape.kind === "line" || shape.kind === "arrow") && pts.length >= 2) {
      const [a, b] = pts;
      svg.appendChild(svgNode("line", { ...common, x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
      if (shape.kind === "arrow") {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const h = 10;
        [ang - Math.PI / 7, ang + Math.PI / 7].forEach((t) => {
          svg.appendChild(svgNode("line", { ...common, x1: b.x, y1: b.y, x2: b.x - h * Math.cos(t), y2: b.y - h * Math.sin(t) }));
        });
      }
    } else if (shape.kind === "freehand" && pts.length >= 2) {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
      svg.appendChild(svgNode("path", { ...common, d }));
    }
  }

  let overlayRaf = 0;
  function scheduleOverlayRedraw() {
    if (overlayRaf) return;
    overlayRaf = requestAnimationFrame(() => {
      overlayRaf = 0;
      drawOverlay();
      // Cards track their anchors, so realign after the overlay's rects update.
      layoutAligned();
    });
  }

  /* ---------------------------------------------------- Drawing tools */
  const DRAW_TOOLS = [
    { tool: "select", glyph: "▱", title: "Select (stop drawing)" },
    { tool: "rect", glyph: "▭", title: "Rectangle" },
    { tool: "ellipse", glyph: "◯", title: "Ellipse" },
    { tool: "arrow", glyph: "↗", title: "Arrow" },
    { tool: "line", glyph: "╱", title: "Line" },
    { tool: "freehand", glyph: "✎", title: "Freehand" }
  ];

  function drawColor() {
    return settings.drawColor || DRAW_PALETTE[0];
  }

  function renderPalette() {
    if (!shadow) return;
    const bar = shadow.getElementById("sn-palette");
    bar.hidden = !paletteOpen;
    if (!paletteOpen) return;
    bar.style.top = `calc(${topInset}px + 12px)`;
    const tools = DRAW_TOOLS.map(
      (t) =>
        `<button class="sn-tool${(drawTool || "select") === t.tool ? " sel" : ""}" data-tool="${t.tool}" title="${t.title}">${t.glyph}</button>`
    ).join("");
    const swatches = DRAW_PALETTE.map(
      (c) =>
        `<button class="sn-ink${c.toLowerCase() === drawColor().toLowerCase() ? " sel" : ""}" style="background:${c}" data-drawcolor="${c}" title="${c}"></button>`
    ).join("");
    const canUndo = undoStack.length > 0 || Boolean(draft);
    bar.innerHTML =
      `<div class="sn-tools">${tools}</div>` +
      `<div class="sn-inks">${swatches}</div>` +
      `<button class="sn-tool sn-palette-undo" data-tool="__undo" title="Undo (⌘Z / Ctrl+Z)"${canUndo ? "" : " disabled"}>↶</button>` +
      `<button class="sn-palette-done" data-tool="__done" title="Close the palette (Esc)">Done</button>`;
  }

  function openPalette() {
    paletteOpen = true;
    setTool(null);
    renderPalette();
  }

  // Fully tear down the drawing UI: any in-progress stroke, the armed tool, and
  // the capture layer — so the palette can always be dismissed cleanly.
  function closePalette() {
    endStroke();
    paletteOpen = false;
    drawTool = null;
    if (shadow) shadow.getElementById("sn-draw-capture").hidden = true;
    renderPalette();
  }

  function endStroke() {
    document.removeEventListener("mousemove", onDrawMove, true);
    document.removeEventListener("mouseup", onDrawEnd, true);
    drawing = null;
    clearPreview();
  }

  function setTool(tool) {
    drawTool = DRAW_TOOLS.some((t) => t.tool === tool) && tool !== "select" ? tool : null;
    if (shadow) {
      shadow.getElementById("sn-draw-capture").hidden = !drawTool;
    }
    renderPalette();
  }

  function onPaletteClick(e) {
    const btn = e.target.closest("[data-tool], [data-drawcolor]");
    if (!btn) return;
    if (btn.dataset.drawcolor) {
      settings.drawColor = btn.dataset.drawcolor;
      setSettings(settings);
      renderPalette();
      return;
    }
    const tool = btn.dataset.tool;
    if (tool === "__done" || tool === "__close") closePalette();
    else if (tool === "__undo") undo();
    else setTool(tool);
  }

  // Which element a page-point should anchor to (null → anchor to the page).
  function elementUnderForDrawing(x, y) {
    const capture = shadow && shadow.getElementById("sn-draw-capture");
    if (capture) capture.style.pointerEvents = "none";
    let el = null;
    try {
      el = document.elementFromPoint(x, y);
    } catch (_) {
      el = null;
    }
    if (capture) capture.style.pointerEvents = "";
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.id === HOST_ID || (el.closest && el.closest(`#${HOST_ID}`))) return null;
    return el;
  }

  function clearPreview() {
    const svg = overlayEl();
    if (svg) svg.querySelectorAll('[data-sidenote-id="__preview__"]').forEach((n) => n.remove());
  }

  function drawPreview() {
    const svg = overlayEl();
    if (!svg || !drawing) return;
    clearPreview();
    drawShape(svg, { id: "__preview__" }, { kind: drawing.kind, points: drawing.points, color: drawColor(), width: 3 }, { left: 0, top: 0 });
  }

  function onDrawStart(e) {
    if (!drawTool) return;
    e.preventDefault();
    drawing = { kind: drawTool, points: [{ x: e.clientX, y: e.clientY }] };
    if (drawTool !== "freehand") drawing.points.push({ x: e.clientX, y: e.clientY });
    document.addEventListener("mousemove", onDrawMove, true);
    document.addEventListener("mouseup", onDrawEnd, true);
  }

  function onDrawMove(e) {
    if (!drawing) return;
    if (drawing.kind === "freehand") drawing.points.push({ x: e.clientX, y: e.clientY });
    else drawing.points[1] = { x: e.clientX, y: e.clientY };
    drawPreview();
  }

  function onDrawEnd() {
    document.removeEventListener("mousemove", onDrawMove, true);
    document.removeEventListener("mouseup", onDrawEnd, true);
    const d = drawing;
    drawing = null;
    clearPreview();
    if (!d) return;

    // Ignore an accidental click (no real drag / too few points).
    if (d.kind === "freehand") {
      if (d.points.length < 3) return;
    } else {
      const [a, b] = d.points;
      if (!b || (Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4)) return;
    }

    const anchor = finalizeDrawing(d);
    // Leave the capture layer so the user can type the note; reselect to draw more.
    setTool(null);
    createNote(anchor);
  }

  function finalizeDrawing(d) {
    const start = d.points[0];
    const el = elementUnderForDrawing(start.x, start.y);
    const shape = { kind: d.kind, color: drawColor(), width: 3 };
    if (el) {
      const r = el.getBoundingClientRect();
      shape.points = d.points.map((p) => ({ x: Math.round(p.x - r.left), y: Math.round(p.y - r.top) }));
      return { type: "region", relativeTo: "element", target: buildTarget(el), shapes: [shape] };
    }
    shape.points = d.points.map((p) => ({ x: Math.round(p.x + window.scrollX), y: Math.round(p.y + window.scrollY) }));
    return { type: "region", relativeTo: "page", target: {}, shapes: [shape] };
  }

  /* ------------------------------------------------- Render dispatcher */
  // Re-anchor and re-render every comment (and the draft) by anchor type.
  // Returns the ids that could not be located so the UI can flag them.
  function renderAnnotations() {
    unwrapAll();
    clearOverlay();
    const orphaned = new Set();
    renderList().forEach((c) => {
      const type = c.anchor.type || "text";
      if (type === "text") {
        const range = findRange(c.anchor);
        if (!range) return orphaned.add(c.id);
        if (highlightRange(range, c).length === 0) orphaned.add(c.id);
      } else if (type === "element") {
        const el = findElement(c.anchor.target);
        if (!el) return orphaned.add(c.id);
        renderPin(c, el);
      } else if (type === "region") {
        if (!renderRegion(c)) orphaned.add(c.id);
      }
    });
    drawOverlay();
    return orphaned;
  }

  // Every element the note's highlight/pin/shape maps to, for scroll + emphasis.
  function targetsFor(id) {
    return Array.from(document.querySelectorAll(`.__sidenote_hl[data-sidenote-id="${cssEscape(id)}"]`)).concat(
      overlayEl() ? Array.from(overlayEl().querySelectorAll(`[data-sidenote-id="${cssEscape(id)}"]`)) : []
    );
  }

  function renderList() {
    return draft ? comments.concat([draft]) : comments;
  }

  /* --------------------------------------------------------- Storage */
  let writeChain = Promise.resolve();
  function mutatePage(fn) {
    writeChain = writeChain.then(async () => {
      const pages = await getPages();
      const existing = pages[PAGE_KEY];
      const e = existing || {
        url: `${location.origin}${location.pathname}${location.search}`,
        title: document.title,
        updatedAt: Date.now(),
        comments: []
      };
      fn(e);
      e.title = document.title || e.title;
      e.updatedAt = Date.now();
      // Keep the entry if it has notes OR an explicit on/off override; otherwise
      // it's just the default state and needn't be stored.
      if ((e.comments || []).length === 0 && typeof e.enabled !== "boolean") {
        delete pages[PAGE_KEY];
      } else {
        pages[PAGE_KEY] = e;
      }
      await setPages(pages);
    });
    return writeChain;
  }

  /* ----------------------------------------------------- Side helpers */
  function sidesInUse() {
    const s = effectiveSides(entry, settings);
    return s === "both" ? ["left", "right"] : [s];
  }

  // Which panel a comment shows in: its own side when that panel exists,
  // otherwise whichever single panel is in use (so nothing is ever hidden).
  function panelSideFor(comment) {
    const inUse = sidesInUse();
    if (inUse.includes(comment.side)) return comment.side;
    return inUse[0];
  }

  function commentsForSide(side) {
    return renderList().filter((c) => panelSideFor(c) === side);
  }

  /* -------------------------------------------------------- Rendering */
  function currentTheme() {
    return resolveTheme(settings.theme);
  }

  function buildHost() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    hostEl.dataset.theme = currentTheme();
    shadow = hostEl.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${SIDEBAR_CSS}</style>
      <div id="sn-draw-capture" class="sn-draw-capture" hidden></div>
      <svg id="sn-overlay" class="sn-overlay"></svg>
      <div id="sn-palette" class="sn-palette-bar" hidden></div>
      <div id="sn-chrome"></div>
      <button id="sn-add" class="sn-add" type="button" hidden>💬 Add note</button>
      <div id="sn-shape-menu" class="sn-shape-menu" hidden>
        <button class="sn-shape-del" type="button" title="Delete (Del)">🗑 Delete</button>
      </div>
      <div id="sn-toast" class="sn-toast" hidden></div>`;
    (document.documentElement || document.body).appendChild(hostEl);

    const palette = shadow.getElementById("sn-palette");
    palette.addEventListener("click", onPaletteClick);
    const capture = shadow.getElementById("sn-draw-capture");
    capture.addEventListener("mousedown", onDrawStart);

    shadow.getElementById("sn-add").addEventListener("mousedown", (e) => e.preventDefault());
    shadow.getElementById("sn-add").addEventListener("click", onAddClick);
    const chromeEl = shadow.getElementById("sn-chrome");
    chromeEl.addEventListener("click", onChromeClick);
    // Hover a card → emphasize its on-page target(s).
    chromeEl.addEventListener("mouseover", (e) => {
      const card = e.target.closest && e.target.closest(".sn-card");
      if (card) emphasizeTargets(card.dataset.id, true);
    });
    chromeEl.addEventListener("mouseout", (e) => {
      const card = e.target.closest && e.target.closest(".sn-card");
      if (card) emphasizeTargets(card.dataset.id, false);
    });
    // Drag a FAB vertically to reposition it (a plain click still opens).
    chromeEl.addEventListener("mousedown", onFabMouseDown);

    hostEl.style.setProperty("--sn-top-inset", `${topInset}px`);
    watchTopBar();
    applyTopInset();

    // Overlay pins/outlines/shapes: click → select (for deletion) + focus card.
    const svg = shadow.getElementById("sn-overlay");
    svg.addEventListener("click", (e) => {
      const id = e.target.getAttribute && e.target.getAttribute("data-sidenote-id");
      if (!id) return;
      selectShape(id, e.clientX, e.clientY);
      focusCard(id);
    });
    svg.addEventListener("mouseover", (e) => {
      const id = e.target.getAttribute && e.target.getAttribute("data-sidenote-id");
      if (id) emphasizeCard(id, true);
    });
    svg.addEventListener("mouseout", (e) => {
      const id = e.target.getAttribute && e.target.getAttribute("data-sidenote-id");
      if (id) emphasizeCard(id, false);
    });

    // Floating delete for the selected drawing/pin.
    shadow.getElementById("sn-shape-menu").addEventListener("click", () => {
      const id = selectedNoteId;
      selectShape(null);
      if (id) deleteComment(id);
    });
  }

  // Select an on-page drawing/pin so it can be deleted (Del key or the menu).
  function selectShape(id, x, y) {
    selectedNoteId = id || null;
    const svg = overlayEl();
    if (svg) {
      svg.querySelectorAll(".sn-ov-selected").forEach((n) => n.classList.remove("sn-ov-selected"));
      if (id) {
        svg.querySelectorAll(`[data-sidenote-id="${cssEscape(id)}"]`).forEach((n) => n.classList.add("sn-ov-selected"));
      }
    }
    const menu = shadow && shadow.getElementById("sn-shape-menu");
    if (menu) {
      if (id && typeof x === "number") {
        menu.hidden = false;
        menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 110, x + 8))}px`;
        menu.style.top = `${Math.max(8, y + 12)}px`;
      } else {
        menu.hidden = true;
      }
    }
  }

  function removeHost() {
    if (hostEl) hostEl.remove();
    hostEl = null;
    shadow = null;
    hideAddButton();
  }

  function applyPush() {
    const html = document.documentElement;
    if (!html) return;
    const w = settings.marginWidth;
    const left = open.left ? w : 0;
    const right = open.right ? w : 0;
    html.style.transition = "margin 0.15s ease";
    if (left) html.style.setProperty("margin-left", `${left}px`, "important");
    else html.style.removeProperty("margin-left");
    if (right) html.style.setProperty("margin-right", `${right}px`, "important");
    else html.style.removeProperty("margin-right");
  }

  /* ------------------------------------------------- Top-bar interop */
  // Other extensions/pages can dock a fixed bar at the top of the page (e.g. our
  // Colorbars extension's #__domain_top_bar__). Because content scripts share
  // the DOM, we can measure such a bar and inset the margin below it — silently,
  // with no cooperation from the other extension. Generalizes to any known
  // top-docked bar.
  const KNOWN_TOP_BARS = ["#__domain_top_bar__"];
  let topInset = 0;

  function measureTopInset() {
    let inset = 0;
    KNOWN_TOP_BARS.forEach((sel) => {
      let el;
      try {
        el = document.querySelector(sel);
      } catch (_) {
        return;
      }
      if (!el || el.id === HOST_ID) return;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") return;
      const r = el.getBoundingClientRect();
      if (r.top <= 1 && r.height > 0 && r.width > window.innerWidth * 0.5) {
        inset = Math.max(inset, Math.round(r.height));
      }
    });
    return inset;
  }

  function applyTopInset() {
    const next = measureTopInset();
    if (next === topInset && hostEl && hostEl.style.getPropertyValue("--sn-top-inset")) return;
    topInset = next;
    if (hostEl) hostEl.style.setProperty("--sn-top-inset", `${topInset}px`);
    repositionFabs();
  }

  // Watch for a top bar appearing, disappearing, or changing height (Colorbars
  // rebuilds its bar element when its settings change).
  let barMutationObserver = null;
  let barResizeObserver = null;
  function watchTopBar() {
    if (!barMutationObserver) {
      barMutationObserver = new MutationObserver(() => {
        watchBarResize();
        applyTopInset();
      });
      barMutationObserver.observe(document.documentElement, { childList: true });
      if (document.body) barMutationObserver.observe(document.body, { childList: true });
    }
    watchBarResize();
  }

  function watchBarResize() {
    if (typeof ResizeObserver === "undefined") return;
    if (barResizeObserver) barResizeObserver.disconnect();
    barResizeObserver = new ResizeObserver(() => applyTopInset());
    KNOWN_TOP_BARS.forEach((sel) => {
      let el;
      try {
        el = document.querySelector(sel);
      } catch (_) {
        return;
      }
      if (el) barResizeObserver.observe(el);
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  function editorHtml(id, value, placeholder) {
    return `<textarea class="sn-textarea" data-id="${esc(id)}" placeholder="${esc(placeholder)}" rows="3">${esc(value || "")}</textarea>
      <div class="sn-card-actions">
        <button class="sn-btn sn-btn-primary" data-action="save" data-id="${esc(id)}">Save</button>
        <button class="sn-btn" data-action="cancel" data-id="${esc(id)}">Cancel</button>
      </div>`;
  }

  function repliesForCard(c) {
    const drafted = replyDraft && replyDraft.commentId === c.id ? [replyDraft.reply] : [];
    return (c.replies || []).concat(drafted);
  }

  function replyHtml(comment, reply) {
    if (reply.id === editingId) {
      return `<div class="sn-reply sn-reply-editing">${editorHtml(reply.id, reply.body, "Write a reply…")}</div>`;
    }
    return `<div class="sn-reply">
        <div class="sn-reply-body">${esc(reply.body)}</div>
        <div class="sn-reply-meta">
          <span>${esc(formatTime(reply.updatedAt || reply.createdAt))}</span>
          <span class="sn-card-tools">
            <button class="sn-icon" title="Edit reply" data-action="edit-reply" data-id="${esc(reply.id)}">✎</button>
            <button class="sn-icon sn-icon-danger" title="Delete reply" data-action="delete-reply" data-id="${esc(reply.id)}" data-comment="${esc(comment.id)}">🗑</button>
          </span>
        </div>
      </div>`;
  }

  function paletteHtml(c) {
    const current = c.color || settings.highlightColor;
    const swatches = HIGHLIGHT_PALETTE.map(
      (col) =>
        `<button class="sn-swatch${col.toLowerCase() === current.toLowerCase() ? " sel" : ""}" style="background:${col}" title="${col}" data-action="set-color" data-id="${esc(c.id)}" data-color="${col}"></button>`
    ).join("");
    return `<div class="sn-palette">${swatches}</div>`;
  }

  // The head of a card: a quote for text notes, a typed descriptor for element
  // and drawing notes.
  function anchorHeadHtml(c) {
    const a = c.anchor;
    if ((a.type || "text") === "text") {
      const quote = esc(a.exact.length > 140 ? a.exact.slice(0, 140) + "…" : a.exact);
      return `<blockquote class="sn-quote" data-action="goto" data-id="${esc(c.id)}">${quote}</blockquote>`;
    }
    const t = a.target || {};
    let label;
    if (a.type === "element") {
      const name = t.attrHint || t.textHint || (t.tag ? `<${t.tag}>` : "element");
      label = `⬚ ${esc(name.length > 90 ? name.slice(0, 90) + "…" : name)}`;
    } else {
      label = `✎ Drawing${t.tag ? ` on <${esc(t.tag)}>` : ""}`;
    }
    return `<div class="sn-target" data-action="goto" data-id="${esc(c.id)}">${label}</div>`;
  }

  function cardHtml(c, orphaned) {
    const isDraft = draft && draft.id === c.id;
    const editingRoot = c.id === editingId;
    const color = c.color || settings.highlightColor;
    const classes = ["sn-card"];
    if (c.resolved) classes.push("sn-card-resolved");
    if (orphaned) classes.push("sn-card-orphan");
    if (editingRoot) classes.push("sn-card-editing");

    const head = anchorHeadHtml(c);

    // Editing the root note (also the state for a brand-new draft).
    if (editingRoot) {
      return `<article class="${classes.join(" ")}" data-id="${esc(c.id)}">
          ${head}
          ${editorHtml(c.id, c.body, "Add your note…")}
        </article>`;
    }

    const bodyBlock = `<div class="sn-body">${c.body ? esc(c.body) : '<span class="sn-body-empty">No note text</span>'}</div>`;

    // A draft is never persisted yet, so no thread/tools until it's saved.
    if (isDraft) {
      return `<article class="${classes.join(" ")}" data-id="${esc(c.id)}">${head}${bodyBlock}</article>`;
    }

    const replies = repliesForCard(c).map((r) => replyHtml(c, r)).join("");
    const repliesBlock = replies ? `<div class="sn-replies">${replies}</div>` : "";
    const replyBtn =
      replyDraft && replyDraft.commentId === c.id
        ? ""
        : `<button class="sn-reply-add" data-action="reply" data-id="${esc(c.id)}">Reply</button>`;

    const tools = `<div class="sn-card-meta">
        <span>${esc(formatTime(c.updatedAt || c.createdAt))}${orphaned ? " · not found on page" : ""}</span>
        <span class="sn-card-tools">
          <button class="sn-icon sn-color-dot" title="Highlight color" data-action="color" data-id="${esc(c.id)}" style="color:${color}">●</button>
          <button class="sn-icon" title="${c.resolved ? "Reopen" : "Resolve"}" data-action="resolve" data-id="${esc(c.id)}">${c.resolved ? "↩" : "✓"}</button>
          ${sidesInUse().length > 1 ? `<button class="sn-icon" title="Move to other side" data-action="flip" data-id="${esc(c.id)}">⇄</button>` : ""}
          <button class="sn-icon" title="Edit note" data-action="edit" data-id="${esc(c.id)}">✎</button>
          <button class="sn-icon sn-icon-danger" title="Delete note" data-action="delete" data-id="${esc(c.id)}">🗑</button>
        </span>
      </div>`;
    const palette = colorPickerId === c.id ? paletteHtml(c) : "";

    const isText = (c.anchor.type || "text") === "text";
    let orphanRow = "";
    if (orphaned) {
      if (reanchorId === c.id) {
        orphanRow = `<div class="sn-orphan-row">Select the new text on the page…
          <button class="sn-link" data-action="reanchor-cancel" data-id="${esc(c.id)}">Cancel</button></div>`;
      } else if (isText) {
        orphanRow = `<div class="sn-orphan-row">
          <button class="sn-link" data-action="reanchor" data-id="${esc(c.id)}">Re-anchor to new text</button></div>`;
      } else {
        orphanRow = `<div class="sn-orphan-row sn-orphan-hint">Right-click the element again to re-link it.</div>`;
      }
    }

    return `<article class="${classes.join(" ")}" data-id="${esc(c.id)}">
        ${head}
        ${bodyBlock}
        ${repliesBlock}
        ${replyBtn}
        ${tools}
        ${orphanRow}
        ${palette}
      </article>`;
  }

  function panelHtml(side, orphaned) {
    const list = commentsForSide(side);
    const aligned = settings.sidebarLayout === "aligned";
    const orphanCount = list.filter((c) => orphaned.has(c.id)).length;
    // The banner uses normal flow; in aligned mode cards are absolutely
    // positioned, so skip it there (orphaned cards still pile at the top).
    const banner =
      orphanCount && !aligned
        ? `<div class="sn-orphan-banner">${orphanCount} note${orphanCount === 1 ? "" : "s"} couldn't be placed on this page (the text or element may have changed).</div>`
        : "";
    const cards = list.length
      ? banner + list.map((c) => cardHtml(c, orphaned.has(c.id))).join("")
      : `<p class="sn-empty">No notes on this side yet. Select text on the page, then choose <strong>Add note</strong>.</p>`;
    return `<aside class="sn-panel sn-panel-${side}">
        <header class="sn-head">
          <div class="sn-brand"><span class="sn-brand-mark">▎</span> SideNote</div>
          <div class="sn-head-tools">
            <button class="sn-icon${paletteOpen ? " sel" : ""}" title="Draw on page" data-action="draw">✎</button>
            <span class="sn-count">${list.filter((c) => !c.resolved).length}</span>
            <button class="sn-icon" title="Close panel" data-action="close" data-side="${side}">✕</button>
          </div>
        </header>
        <div class="sn-cards${aligned ? " sn-cards-aligned" : ""}">${cards}</div>
        <footer class="sn-foot">
          <button class="sn-link" data-action="all-notes">All notes</button>
          <button class="sn-link" data-action="settings">Settings</button>
        </footer>
      </aside>`;
  }

  // Vertical FAB position (px), honoring the top-bar inset and viewport bounds.
  function clampFabTop(y) {
    const min = topInset + 28;
    const max = window.innerHeight - 28;
    return Math.min(max, Math.max(min, y));
  }

  function fabTopPx() {
    return clampFabTop(Math.round(settings.fabPosition * window.innerHeight));
  }

  function fabHtml(side, count) {
    return `<button class="sn-fab sn-fab-${side}" data-action="open" data-side="${side}" style="top:${fabTopPx()}px" title="Open SideNote (${count} note${count === 1 ? "" : "s"}) — drag to move">
        <span class="sn-fab-mark">💬</span>${count ? `<span class="sn-fab-count">${count}</span>` : ""}
      </button>`;
  }

  // Reposition open FABs in place (on resize / inset change) without a re-render.
  function repositionFabs() {
    if (!shadow) return;
    shadow.querySelectorAll(".sn-fab").forEach((fab) => {
      fab.style.top = `${fabTopPx()}px`;
    });
  }

  // Drag a FAB up/down; on release, persist the new position. A drag under the
  // movement threshold falls through to the normal click (open the panel).
  let fabDragged = false;
  function onFabMouseDown(e) {
    const fab = e.target.closest && e.target.closest(".sn-fab");
    if (!fab) return;
    const startY = e.clientY;
    let moved = false;
    const onMove = (ev) => {
      if (Math.abs(ev.clientY - startY) > 4) moved = true;
      if (moved) fab.style.top = `${clampFabTop(ev.clientY)}px`;
    };
    const onUp = (ev) => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      if (!moved) return;
      // Suppress only the synthetic click that immediately follows this drag;
      // clear on a macrotask so a later click still opens the panel.
      fabDragged = true;
      setTimeout(() => (fabDragged = false), 0);
      settings.fabPosition = Math.min(0.95, Math.max(0.05, clampFabTop(ev.clientY) / window.innerHeight));
      setSettings(settings);
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  function render() {
    if (!shadow) return;
    hostEl.dataset.theme = currentTheme();
    // Pause the DOM observer around our own span mutations so we don't loop.
    if (domObserver) domObserver.disconnect();
    const orphaned = renderAnnotations();
    lastOrphanCount = orphaned.size;
    if (domObserver && document.body) {
      domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    const chromeEl = shadow.getElementById("sn-chrome");
    let html = "";
    sidesInUse().forEach((side) => {
      if (open[side]) {
        html += panelHtml(side, orphaned);
      } else if (settings.showTab) {
        const count = commentsForSide(side).filter((c) => !c.resolved).length;
        html += fabHtml(side, count);
      }
    });
    chromeEl.innerHTML = html;
    applyPush();
    renderPalette();
    shadow.getElementById("sn-draw-capture").hidden = !drawTool;
    layoutAligned();

    if (editingId) {
      const ta = shadow.querySelector(`.sn-textarea[data-id="${cssEscape(editingId)}"]`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
  }

  // Aligned layout: position each card at its anchor's vertical position on the
  // page (panel-relative), then push overlapping cards down. Cards for off-screen
  // anchors fall outside the panel and are clipped; orphaned notes pile at the top.
  function layoutAligned() {
    if (!shadow || settings.sidebarLayout !== "aligned") return;
    const GAP = 8;
    shadow.querySelectorAll(".sn-cards-aligned").forEach((body) => {
      const bodyTop = body.getBoundingClientRect().top;
      const items = Array.from(body.querySelectorAll(".sn-card")).map((card) => {
        const t = targetsFor(card.dataset.id)[0];
        const desired = t ? t.getBoundingClientRect().top - bodyTop : 0;
        return { card, desired, h: card.offsetHeight };
      });
      items.sort((a, b) => a.desired - b.desired);
      let prevBottom = -Infinity;
      items.forEach((it) => {
        const y = Math.max(it.desired, prevBottom + GAP);
        it.card.style.top = `${Math.round(y)}px`;
        prevBottom = y + it.h;
      });
    });
  }

  /* -------------------------------------------------- Chrome actions */
  function onChromeClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;
    const side = el.dataset.side;

    switch (action) {
      case "open":
        if (fabDragged) break; // this click ended a drag; cleared on a timeout
        open[side] = true;
        render();
        break;
      case "close":
        open[side] = false;
        cancelEdit();
        render();
        break;
      case "goto":
        gotoHighlight(id);
        break;
      case "edit":
        editingId = id;
        colorPickerId = null;
        render();
        break;
      case "cancel":
        cancelEdit();
        render();
        break;
      case "save":
        saveEdit(id);
        break;
      case "reply":
        startReply(id);
        break;
      case "edit-reply":
        editingId = id;
        render();
        break;
      case "delete-reply":
        deleteReply(el.dataset.comment, id);
        break;
      case "color":
        colorPickerId = colorPickerId === id ? null : id;
        render();
        break;
      case "reanchor":
        startReanchor(id);
        break;
      case "reanchor-cancel":
        reanchorId = null;
        hideAddButton();
        render();
        break;
      case "set-color":
        setColor(id, el.dataset.color);
        break;
      case "resolve":
        toggleResolve(id);
        break;
      case "flip":
        flipSide(id);
        break;
      case "delete":
        deleteComment(id);
        break;
      case "draw":
        if (paletteOpen) closePalette();
        else openPalette();
        break;
      case "all-notes":
        chrome.runtime.sendMessage({ type: "sn-open-tab", page: "pages.html" });
        break;
      case "settings":
        chrome.runtime.sendMessage({ type: "sn-open-tab", page: "options.html" });
        break;
      default:
        break;
    }
  }

  // Scroll to a note's target (text highlight, element pin, or drawing) and
  // flash it. For overlay items we scroll the underlying element into view.
  function gotoHighlight(id) {
    const c = renderList().find((x) => x.id === id);
    const spans = Array.from(document.querySelectorAll(`.__sidenote_hl[data-sidenote-id="${cssEscape(id)}"]`));
    if (spans.length) {
      spans[0].scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (c && c.anchor.type !== "text") {
      const el = c.anchor.type === "element" ? findElement(c.anchor.target)
        : c.anchor.relativeTo === "element" ? findElement(c.anchor.target) : null;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      else {
        showToast("This note's target wasn't found on the page.");
        return;
      }
      setTimeout(scheduleOverlayRedraw, 350);
    } else {
      showToast("This note's text wasn't found on the page.");
      return;
    }
    flashTargets(id);
  }

  function flashTargets(id) {
    targetsFor(id).forEach((t) => {
      const flashClass = t.classList.contains("__sidenote_hl") ? "__sidenote_hl_flash" : "sn-ov-flash";
      t.classList.add(flashClass);
      setTimeout(() => t.classList.remove(flashClass), 1000);
    });
  }

  // Bidirectional hover emphasis between a card and its on-page target(s).
  function emphasizeTargets(id, on) {
    targetsFor(id).forEach((t) => {
      if (t.classList.contains("__sidenote_hl")) t.classList.toggle("__sidenote_hl_active", on);
      else t.classList.toggle("sn-ov-active", on);
    });
  }

  function emphasizeCard(id, on) {
    if (!shadow) return;
    const card = shadow.querySelector(`.sn-card[data-id="${cssEscape(id)}"]`);
    if (card) card.classList.toggle("sn-card-hover", on);
  }

  function focusCard(id) {
    const c = renderList().find((x) => x.id === id);
    if (c) open[panelSideFor(c)] = true;
    render();
    const card = shadow.querySelector(`.sn-card[data-id="${cssEscape(id)}"]`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("sn-card-flash");
      setTimeout(() => card.classList.remove("sn-card-flash"), 1000);
    }
  }

  function findReply(replyId) {
    for (const c of comments) {
      const reply = (c.replies || []).find((r) => r.id === replyId);
      if (reply) return { comment: c, reply };
    }
    return null;
  }

  function saveEdit(id) {
    const ta = shadow.querySelector(`.sn-textarea[data-id="${cssEscape(id)}"]`);
    const body = ta ? ta.value.trim() : "";

    // New top-level comment draft.
    if (draft && draft.id === id) {
      draft.body = body;
      draft.updatedAt = Date.now();
      const toSave = { ...draft };
      draft = null;
      editingId = null;
      comments.push(toSave); // optimistic; storage change will reconcile
      pushUndo({ kind: "add", id: toSave.id });
      mutatePage((e) => {
        e.enabled = true;
        e.comments = (e.comments || []).filter((c) => c.id !== toSave.id).concat([toSave]);
      });
      showToast("Note added.");
      return;
    }

    // New reply draft — drop it if empty.
    if (replyDraft && replyDraft.reply.id === id) {
      const commentId = replyDraft.commentId;
      replyDraft = null;
      editingId = null;
      if (!body) {
        render();
        return;
      }
      const reply = { id, body, createdAt: Date.now(), updatedAt: Date.now() };
      const c = comments.find((x) => x.id === commentId);
      if (c) c.replies = (c.replies || []).concat([reply]); // optimistic
      mutatePage((e) => {
        const target = (e.comments || []).find((x) => x.id === commentId);
        if (target) {
          target.replies = (target.replies || []).filter((r) => r.id !== id).concat([reply]);
        }
      });
      return;
    }

    // Editing an existing reply.
    const rt = findReply(id);
    if (rt) {
      editingId = null;
      rt.reply.body = body;
      rt.reply.updatedAt = Date.now();
      mutatePage((e) => {
        const c = (e.comments || []).find((x) => x.id === rt.comment.id);
        const r = c && (c.replies || []).find((x) => x.id === id);
        if (r) {
          r.body = body;
          r.updatedAt = rt.reply.updatedAt;
        }
      });
      return;
    }

    // Editing an existing top-level note body.
    const c = comments.find((x) => x.id === id);
    if (c) {
      c.body = body;
      c.updatedAt = Date.now();
      mutatePage((e) => {
        const target = (e.comments || []).find((x) => x.id === id);
        if (target) {
          target.body = body;
          target.updatedAt = c.updatedAt;
        }
      });
    }
    editingId = null;
  }

  function startReply(commentId) {
    const reply = { id: genId("reply"), body: "", createdAt: Date.now(), updatedAt: Date.now() };
    replyDraft = { commentId, reply };
    editingId = reply.id;
    colorPickerId = null;
    render();
  }

  function deleteReply(commentId, replyId) {
    const c = comments.find((x) => x.id === commentId);
    if (c) c.replies = (c.replies || []).filter((r) => r.id !== replyId);
    if (editingId === replyId) editingId = null;
    mutatePage((e) => {
      const target = (e.comments || []).find((x) => x.id === commentId);
      if (target) target.replies = (target.replies || []).filter((r) => r.id !== replyId);
    });
  }

  function setColor(commentId, color) {
    if (!/^#([A-Fa-f0-9]{6})$/.test(String(color || ""))) return;
    colorPickerId = null;
    const c = comments.find((x) => x.id === commentId) || (draft && draft.id === commentId ? draft : null);
    if (!c) return;
    c.color = color;
    if (draft && draft.id === commentId) {
      render();
      return;
    }
    mutatePage((e) => {
      const target = (e.comments || []).find((x) => x.id === commentId);
      if (target) target.color = color;
    });
  }

  function cancelEdit() {
    if (draft && draft.id === editingId) draft = null;
    if (replyDraft && replyDraft.reply.id === editingId) replyDraft = null;
    editingId = null;
  }

  function toggleResolve(id) {
    const c = comments.find((x) => x.id === id);
    if (!c) return;
    c.resolved = !c.resolved;
    mutatePage((e) => {
      const target = (e.comments || []).find((x) => x.id === id);
      if (target) target.resolved = c.resolved;
    });
  }

  function flipSide(id) {
    const c = comments.find((x) => x.id === id) || (draft && draft.id === id ? draft : null);
    if (!c) return;
    c.side = c.side === "left" ? "right" : "left";
    // Make sure the destination panel is open so the note stays visible.
    if (sidesInUse().includes(c.side)) open[c.side] = true;
    if (draft && draft.id === id) {
      render();
      return;
    }
    mutatePage((e) => {
      const target = (e.comments || []).find((x) => x.id === id);
      if (target) target.side = c.side;
    });
  }

  function deleteComment(id, skipUndo) {
    if (draft && draft.id === id) {
      draft = null;
      editingId = null;
      render();
      return;
    }
    const removed = comments.find((c) => c.id === id);
    if (removed && !skipUndo) pushUndo({ kind: "remove", comment: JSON.parse(JSON.stringify(removed)) });
    comments = comments.filter((c) => c.id !== id);
    if (editingId === id) editingId = null;
    if (selectedNoteId === id) selectedNoteId = null;
    mutatePage((e) => {
      e.comments = (e.comments || []).filter((c) => c.id !== id);
    });
  }

  /* ------------------------------------------------------------- Undo */
  function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > 30) undoStack.shift();
    if (paletteOpen) renderPalette();
  }

  function undo() {
    // An unsaved draft (e.g. a shape just drawn, note not yet typed) → discard it.
    if (draft) {
      draft = null;
      editingId = null;
      render();
      return;
    }
    const action = undoStack.pop();
    if (!action) {
      showToast("Nothing to undo");
      return;
    }
    if (action.kind === "add") {
      deleteComment(action.id, true);
    } else if (action.kind === "remove" && action.comment) {
      const c = action.comment;
      comments = comments.filter((x) => x.id !== c.id).concat([c]);
      open[panelSideFor(c)] = true;
      mutatePage((e) => {
        e.enabled = true;
        e.comments = (e.comments || []).filter((x) => x.id !== c.id).concat([c]);
      });
    }
    if (paletteOpen) renderPalette();
  }

  /* ----------------------------------------------- Selection → add */
  let pendingRect = null;

  function onSelectionChange() {
    if (!active) return;
    // The selection button normally honors the setting, but a re-anchor in
    // progress always needs it.
    if (!settings.addSelectionButton && !reanchorId) return;
    // Debounce with rAF so we read a settled selection.
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.toString().trim()) {
        hideAddButton();
        return;
      }
      const anchorNode = sel.anchorNode;
      if (anchorNode && hostEl && hostEl.contains(anchorNode)) {
        hideAddButton();
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        hideAddButton();
        return;
      }
      pendingRect = rect;
      showAddButton(rect);
    });
  }

  function showAddButton(rect) {
    if (!shadow) return;
    const btn = shadow.getElementById("sn-add");
    btn.hidden = false;
    btn.textContent = reanchorId ? "↪ Re-anchor here" : "💬 Add note";
    // Sit just above the selection (below it when there's no room up top).
    const top = rect.top - 40 < 8 ? rect.bottom + window.scrollY + 8 : rect.top + window.scrollY - 40;
    const left = Math.max(8, Math.min(window.innerWidth - 130, rect.left + window.scrollX));
    btn.style.top = `${top}px`;
    btn.style.left = `${left}px`;
  }

  function hideAddButton() {
    if (!shadow) return;
    const btn = shadow.getElementById("sn-add");
    if (btn) btn.hidden = true;
    pendingRect = null;
  }

  function onAddClick() {
    const anchor = anchorFromSelection();
    if (!anchor) {
      showToast("Select some text on the page first.");
      return;
    }
    hideAddButton();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    if (reanchorId) {
      reanchorNote(reanchorId, anchor);
      return;
    }
    createNote(anchor);
  }

  function startReanchor(id) {
    reanchorId = id;
    colorPickerId = null;
    showToast("Select the new text on the page, then click “Re-anchor here”.");
    render();
  }

  function reanchorNote(id, anchor) {
    const c = comments.find((x) => x.id === id);
    reanchorId = null;
    if (!c) {
      render();
      return;
    }
    c.anchor = anchor;
    c.updatedAt = Date.now();
    mutatePage((e) => {
      const target = (e.comments || []).find((x) => x.id === id);
      if (target) {
        target.anchor = anchor;
        target.updatedAt = c.updatedAt;
      }
    });
    showToast("Note re-anchored.");
  }

  // Build an element anchor from a right-clicked element (no highlight; a pin).
  // Tags that are meaningful to link on their own — don't climb out of these.
  const SELF_MEANINGFUL = new Set(["IMG", "VIDEO", "AUDIO", "CANVAS", "INPUT", "BUTTON", "A", "SELECT", "TEXTAREA", "SUMMARY"]);

  // Right-clicking a custom widget (a checkbox, an icon button) usually targets
  // a leaf like an <svg>/<rect>/<span>. Climb to the nearest real control or
  // <label> so the note attaches to something meaningful and re-findable.
  function meaningfulTarget(el) {
    if (!el || SELF_MEANINGFUL.has(el.tagName)) return el;
    const svg = el.closest && el.closest("svg");
    const start = svg || el;
    const SEL = "a[href],button,label,input,select,textarea,summary,[role],[contenteditable='true']";
    let hop = start;
    for (let i = 0; i < 5 && hop && hop.tagName !== "BODY"; i += 1, hop = hop.parentElement) {
      if (hop.id === HOST_ID) break;
      if (hop.matches && hop.matches(SEL)) return hop;
    }
    return start;
  }

  // precise=true keeps the exact element (used by DevTools $0 selection).
  function anchorFromElement(rawEl, precise) {
    let el = rawEl;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (!precise) el = meaningfulTarget(el) || el;
    if (el.id === HOST_ID || (el.closest && el.closest(`#${HOST_ID}`))) return null;
    if (el === document.body || el === document.documentElement) return null;
    return { type: "element", target: buildTarget(el) };
  }

  // Entry point shared by the context menu and keyboard command. When the page
  // isn't active yet, enable it first and create the note once it mounts.
  let pendingAction = null;
  function requestCreate(makeAnchor) {
    const run = () => {
      const anchor = makeAnchor();
      if (!anchor) {
        if (shadow) showToast("Nothing to attach a note to — select text or right-click an element.");
        return;
      }
      createNote(anchor);
    };
    if (active) {
      run();
      return;
    }
    pendingAction = run;
    mutatePage((e) => {
      e.enabled = true;
    });
  }

  // Persist the current draft (even with an empty body). Used when auto-save is
  // on and the user moves on to another note or leaves the page.
  function commitDraft() {
    if (!draft) return;
    const ta = shadow && shadow.querySelector(`.sn-textarea[data-id="${cssEscape(draft.id)}"]`);
    if (ta) draft.body = ta.value.trim();
    draft.updatedAt = Date.now();
    const toSave = { ...draft };
    if (editingId === draft.id) editingId = null;
    draft = null;
    comments.push(toSave);
    pushUndo({ kind: "add", id: toSave.id });
    mutatePage((e) => {
      e.enabled = true;
      e.comments = (e.comments || []).filter((c) => c.id !== toSave.id).concat([toSave]);
    });
  }

  // The single note-creation pipeline. Every trigger (the selection button, the
  // context menu, the keyboard command, and the drawing tools in a later phase)
  // funnels through here: it opens a draft card in edit mode on the right side.
  function createNote(anchor, opts) {
    if (!active) return;
    // Auto-save mode: starting a new note keeps the previous one (a highlight
    // alone can be enough). Explicit-save mode discards an unsaved draft.
    if (draft && !settings.requireExplicitSave) commitDraft();
    const o = opts || {};
    const inUse = sidesInUse();
    const side = o.side && inUse.includes(o.side)
      ? o.side
      : inUse.includes(settings.defaultSides)
      ? settings.defaultSides
      : inUse.includes("right")
      ? "right"
      : inUse[0];
    draft = {
      id: genId("note"),
      anchor,
      body: "",
      side,
      color: o.color || settings.highlightColor,
      resolved: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      replies: []
    };
    editingId = draft.id;
    colorPickerId = null;
    open[panelSideFor(draft)] = true;
    render();
  }

  /* ------------------------------------------------------------- Toast */
  let toastTimer = null;
  function showToast(msg) {
    if (!shadow) return;
    const t = shadow.getElementById("sn-toast");
    t.textContent = msg;
    t.hidden = false;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => (t.hidden = true), 200);
    }, 2600);
  }

  /* ------------------------------------------------------ Mount cycle */
  // Open a side automatically when it already has unresolved notes.
  function autoOpenSidesWithNotes() {
    sidesInUse().forEach((side) => {
      if (commentsForSide(side).some((c) => !c.resolved)) open[side] = true;
    });
  }

  // --- Late-content handling: notes should appear on load without a reload. ---
  // Frameworks lazy-render or hydrate after document_idle, so an anchor may not
  // match on the first pass. We re-render a few times right after mount, and keep
  // a debounced MutationObserver that re-anchors whenever the DOM changes while
  // notes are still unplaced (paused during our own span mutations — see render).
  let domObserver = null;
  let lastOrphanCount = 0;
  let reanchorTimer = null;

  function scheduleReanchor() {
    clearTimeout(reanchorTimer);
    reanchorTimer = setTimeout(() => {
      if (active) render();
    }, 300);
  }

  function startDomObserver() {
    if (domObserver || !document.body) return;
    domObserver = new MutationObserver(() => {
      if (lastOrphanCount > 0) scheduleReanchor();
    });
    domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopDomObserver() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    clearTimeout(reanchorTimer);
  }

  function scheduleInitialPasses() {
    // rAF catches synchronous late layout; the timers catch async content.
    requestAnimationFrame(() => {
      if (active) render();
    });
    [250, 800, 1800].forEach((ms) =>
      setTimeout(() => {
        if (active && lastOrphanCount > 0) render();
      }, ms)
    );
    if (document.readyState !== "complete") {
      window.addEventListener("load", () => {
        if (active) render();
      }, { once: true });
    }
  }

  function applyState() {
    const wasActive = active;
    active = isPageEnabled(entry, settings, location.href);

    if (active && !wasActive) {
      buildHost();
      autoOpenSidesWithNotes();
      scheduleInitialPasses();
    }
    // The re-anchor observer only matters when there are notes to place; keep it
    // off on the (now many) enabled-but-empty pages.
    if (active && comments.length > 0) startDomObserver();
    else stopDomObserver();
    if (!active && wasActive) {
      unwrapAll();
      clearOverlay();
      stopDomObserver();
      const html = document.documentElement;
      if (html) {
        html.style.removeProperty("margin-left");
        html.style.removeProperty("margin-right");
      }
      removeHost();
      return;
    }
    if (active) render();
    // A context-menu/keyboard add on an inactive page enabled it above; run the
    // queued creation now that the UI is mounted.
    if (active && pendingAction) {
      const p = pendingAction;
      pendingAction = null;
      p();
    }
  }

  async function reload() {
    settings = await getSettings();
    const pages = await getPages();
    entry = pages[PAGE_KEY] || null;
    comments = entry ? entry.comments.slice() : [];
    // Drop a stale editing id (unless it points at a live draft/reply/note).
    if (editingId && !editIdStillValid()) editingId = null;
    if (colorPickerId && !comments.some((c) => c.id === colorPickerId)) colorPickerId = null;
    applyState();
  }

  function editIdStillValid() {
    if (draft && draft.id === editingId) return true;
    if (replyDraft && replyDraft.reply.id === editingId) return true;
    if (comments.some((c) => c.id === editingId)) return true;
    return comments.some((c) => (c.replies || []).some((r) => r.id === editingId));
  }

  /* --------------------------------------------------------- Wiring */
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("click", (e) => {
    // Click on a text highlight → jump to its card.
    const hl = e.target.closest && e.target.closest(".__sidenote_hl");
    if (hl && active) focusCard(hl.getAttribute("data-sidenote-id"));
  });
  // Hover a text highlight → emphasize its card (and vice versa, wired below).
  document.addEventListener("mouseover", (e) => {
    const hl = e.target.closest && e.target.closest(".__sidenote_hl");
    if (hl && active) emphasizeCard(hl.getAttribute("data-sidenote-id"), true);
  });
  document.addEventListener("mouseout", (e) => {
    const hl = e.target.closest && e.target.closest(".__sidenote_hl");
    if (hl && active) emphasizeCard(hl.getAttribute("data-sidenote-id"), false);
  });
  window.addEventListener("scroll", hideAddButton, { passive: true });
  // Keep pins/drawings aligned with their elements as the page scrolls/resizes;
  // the floating delete menu would be mispositioned, so hide it (selection stays).
  window.addEventListener(
    "scroll",
    () => {
      scheduleOverlayRedraw();
      const menu = shadow && shadow.getElementById("sn-shape-menu");
      if (menu && !menu.hidden) menu.hidden = true;
    },
    { passive: true }
  );
  // Clicking the page (outside our UI) clears an on-page shape selection.
  document.addEventListener("click", (e) => {
    if (active && selectedNoteId && e.target !== hostEl && !(hostEl && hostEl.contains(e.target))) {
      selectShape(null);
    }
  });
  window.addEventListener("resize", () => {
    scheduleOverlayRedraw();
    applyTopInset();
    repositionFabs();
  }, { passive: true });
  // Leaving the page saves an open draft (best-effort) when auto-save is on.
  window.addEventListener("pagehide", () => {
    if (draft && !settings.requireExplicitSave) commitDraft();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "sync" && changes[SETTINGS_KEY]) || (area === "local" && changes[PAGES_KEY])) {
      reload();
    }
  });

  prefersDark.addEventListener("change", () => {
    if (active && settings.theme === "auto") render();
  });

  // Remember the element under the last right-click so the context-menu handler
  // can link a note to it (contextMenus doesn't hand us the DOM node).
  let lastCtxEl = null;
  document.addEventListener("contextmenu", (e) => { lastCtxEl = e.target; }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "sn-open") {
      if (!active) return;
      sidesInUse().forEach((side) => (open[side] = true));
      render();
    } else if (msg.type === "sn-add-selection") {
      requestCreate(() => anchorFromSelection());
    } else if (msg.type === "sn-add-element") {
      requestCreate(() => anchorFromElement(lastCtxEl));
    } else if (msg.type === "sn-devtools-link") {
      // The DevTools sidebar marked the inspected element ($0) with an
      // attribute; link that exact element (no ancestor climb).
      requestCreate(() => {
        const el = document.querySelector("[data-sidenote-pick]");
        if (el) el.removeAttribute("data-sidenote-pick");
        return anchorFromElement(el, true);
      });
    } else if (msg.type === "sn-draw") {
      if (!active) {
        pendingAction = () => openPalette();
        mutatePage((e) => {
          e.enabled = true;
        });
      } else {
        openPalette();
      }
    }
  });

  function isEditableFocused() {
    const editable = (el) =>
      el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
    const ae = document.activeElement;
    if (editable(ae)) return true;
    if (ae === hostEl && shadow && editable(shadow.activeElement)) return true;
    return false;
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (!active) return;

      // Escape: cancel a re-anchor, then a stroke, then disarm the tool, then
      // close the palette, then clear an on-page selection.
      if (e.key === "Escape") {
        if (reanchorId) {
          reanchorId = null;
          hideAddButton();
          render();
        } else if (drawing) endStroke();
        else if (drawTool) setTool(null);
        else if (paletteOpen) closePalette();
        else if (selectedNoteId) selectShape(null);
        return;
      }

      // Undo — Cmd/Ctrl+Z, unless the user is undoing text in a field.
      if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (isEditableFocused()) return;
        if (undoStack.length || draft) {
          e.preventDefault();
          undo();
        }
        return;
      }

      // Delete/Backspace removes an on-page-selected drawing or pin.
      if ((e.key === "Delete" || e.key === "Backspace") && selectedNoteId && !isEditableFocused()) {
        e.preventDefault();
        const id = selectedNoteId;
        selectShape(null);
        deleteComment(id);
      }
    },
    true
  );

  // Single-page-app navigation: the URL can change without a reload, so re-key
  // to the new page's notes when it does.
  let lastHref = location.href;
  function onLocationMaybeChanged() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    hideAddButton();
    const newKey = pageKeyFromHref(location.href);
    if (newKey === PAGE_KEY) return; // hash-only change keeps the same notes

    if (active) unwrapAll();
    PAGE_KEY = newKey;
    draft = null;
    replyDraft = null;
    editingId = null;
    colorPickerId = null;
    open.left = false;
    open.right = false;
    reload().then(() => {
      if (active) {
        autoOpenSidesWithNotes();
        render();
      }
      // The SPA may still be swapping content; re-anchor once more shortly.
      setTimeout(() => {
        if (active) render();
      }, 350);
    });
  }

  // Prefer the Navigation API: its "navigatesuccess" fires (after the URL has
  // committed) for same-document pushState/replaceState navigations — which
  // popstate misses — as well as history traversals. It's observable from the
  // content script's isolated world, unlike patching history.pushState. Older
  // Chrome without the Navigation API falls back to popstate + a light poll.
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigatesuccess", onLocationMaybeChanged);
    // hashchange still comes through window; keep it for hash-only URL edits.
    window.addEventListener("hashchange", onLocationMaybeChanged);
  } else {
    window.addEventListener("popstate", onLocationMaybeChanged);
    window.addEventListener("hashchange", onLocationMaybeChanged);
    setInterval(onLocationMaybeChanged, 700);
  }

  reload();

  /* ---------------------------------------------- Shadow-root styles */
  const SIDEBAR_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Roboto","Segoe UI",system-ui,-apple-system,Arial,sans-serif; }
    :host {
      --bg:#f8f9fa; --surface:#ffffff; --surface-2:#f1f3f4; --text:#202124;
      --text-secondary:#5f6368; --text-faint:#80868b; --border:#dadce0;
      --border-strong:#bdc1c6; --accent:#1a73e8; --accent-contrast:#ffffff;
      --danger:#d93025; --shadow:0 1px 3px rgba(60,64,67,.15),0 4px 12px rgba(60,64,67,.12);
    }
    :host([data-theme="dark"]) {
      --bg:#202124; --surface:#292a2d; --surface-2:#35363a; --text:#e8eaed;
      --text-secondary:#9aa0a6; --text-faint:#80868b; --border:#3c4043;
      --border-strong:#5f6368; --accent:#8ab4f8; --accent-contrast:#202124;
      --danger:#f28b82; --shadow:0 1px 3px rgba(0,0,0,.5),0 4px 12px rgba(0,0,0,.4);
    }

    /* Drawing capture layer + tool palette */
    .sn-draw-capture {
      position: fixed; inset: 0; z-index: 2147483646; cursor: crosshair;
      background: transparent;
    }
    .sn-palette-bar {
      position: fixed; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; display: flex; align-items: center; gap: 10px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border); border-radius: 999px;
      box-shadow: var(--shadow); padding: 6px 10px;
    }
    .sn-palette-bar .sn-tools, .sn-palette-bar .sn-inks { display: flex; align-items: center; gap: 4px; }
    .sn-palette-bar .sn-inks { padding-left: 8px; border-left: 1px solid var(--border); }
    .sn-tool {
      width: 30px; height: 30px; border-radius: 8px; border: 1px solid transparent;
      background: transparent; color: var(--text); cursor: pointer; font-size: 15px;
      display: flex; align-items: center; justify-content: center; line-height: 1;
    }
    .sn-tool:hover { background: var(--surface-2); }
    .sn-tool.sel { background: var(--accent); color: var(--accent-contrast); }
    .sn-tool[disabled] { opacity: 0.4; cursor: default; }
    .sn-tool[disabled]:hover { background: transparent; }
    .sn-palette-undo { color: var(--text-secondary); font-size: 16px; }
    .sn-palette-done {
      border: none; background: var(--accent); color: var(--accent-contrast);
      border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 600;
      cursor: pointer; margin-left: 4px;
    }
    .sn-palette-done:hover { filter: brightness(0.96); }
    .sn-ink {
      width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--border);
      cursor: pointer; padding: 0;
    }
    .sn-ink:hover { transform: scale(1.12); }
    .sn-ink.sel { box-shadow: 0 0 0 2px var(--accent); }

    /* Floating delete for a selected drawing/pin */
    .sn-shape-menu {
      position: fixed; z-index: 2147483647;
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: var(--shadow); padding: 4px;
    }
    .sn-shape-del {
      border: none; background: transparent; color: var(--danger);
      cursor: pointer; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 6px;
    }
    .sn-shape-del:hover { background: var(--surface-2); }

    .sn-panel {
      position: fixed; top: var(--sn-top-inset, 0px); bottom: 0; width: 320px;
      background: var(--bg); color: var(--text);
      border-left: 1px solid var(--border); border-right: 1px solid var(--border);
      box-shadow: var(--shadow); z-index: 2147483646;
      display: flex; flex-direction: column; font-size: 13px;
    }
    .sn-panel-left { left: 0; border-left: none; }
    .sn-panel-right { right: 0; border-right: none; }

    .sn-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; border-bottom: 1px solid var(--border); background: var(--surface);
    }
    .sn-brand { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 6px; }
    .sn-brand-mark { color: var(--accent); font-weight: 700; }
    .sn-head-tools { display: flex; align-items: center; gap: 8px; }
    .sn-count {
      min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
      background: var(--accent); color: var(--accent-contrast);
      font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center;
    }

    .sn-cards { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    /* Aligned layout: cards are absolutely positioned to track their anchors. */
    .sn-cards-aligned { position: relative; overflow: hidden; padding: 0; display: block; }
    .sn-cards-aligned .sn-card { position: absolute; left: 12px; right: 12px; }
    .sn-cards-aligned .sn-empty { position: absolute; top: 12px; left: 12px; right: 12px; }

    .sn-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      padding: 10px 12px; box-shadow: var(--shadow);
    }
    .sn-card-editing { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .sn-card-resolved { opacity: 0.75; }
    .sn-card-resolved .sn-body { text-decoration: line-through; text-decoration-color: var(--text-faint); }
    .sn-card-orphan { border-style: dashed; }
    .sn-card-hover { border-color: var(--accent); }
    .sn-card-flash { animation: sn-card-flash 1s ease; }
    @keyframes sn-card-flash {
      0%,100% { box-shadow: 0 0 0 0 rgba(26,115,232,0); }
      30% { box-shadow: 0 0 0 2px var(--accent); }
    }

    /* Overlay layer for element pins and drawings. */
    .sn-overlay {
      position: fixed; inset: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 2147483645; overflow: visible;
    }
    .sn-overlay .sn-ov-pin, .sn-overlay .sn-ov-outline, .sn-overlay .sn-ov-shape { pointer-events: auto; cursor: pointer; }
    .sn-overlay .sn-ov-active, .sn-overlay .sn-ov-flash { filter: drop-shadow(0 0 3px var(--accent)); }
    .sn-overlay .sn-ov-selected { filter: drop-shadow(0 0 4px var(--accent)); stroke-dasharray: 5 3; }
    .sn-overlay .sn-ov-flash { animation: sn-ov-flash 1s ease; }
    @keyframes sn-ov-flash { 0%,100% { opacity: 1; } 40% { opacity: 0.35; } }

    .sn-quote {
      margin: 0 0 8px; padding: 4px 0 4px 10px; border-left: 3px solid var(--accent);
      color: var(--text-secondary); font-style: italic; font-size: 12px; cursor: pointer;
      max-height: 4.5em; overflow: hidden;
    }
    .sn-quote:hover { color: var(--text); }
    .sn-target {
      margin: 0 0 8px; padding: 4px 8px; border-radius: 6px; background: var(--surface-2);
      color: var(--text-secondary); font-size: 12px; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sn-target:hover { color: var(--text); }
    .sn-body { white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
    .sn-body-empty { color: var(--text-faint); font-style: italic; }

    .sn-card-meta {
      margin-top: 8px; display: flex; align-items: center; justify-content: space-between;
      gap: 8px; color: var(--text-faint); font-size: 11px;
    }
    .sn-card-tools { display: flex; gap: 2px; }

    .sn-icon {
      border: none; background: transparent; color: var(--text-secondary);
      cursor: pointer; border-radius: 6px; padding: 3px 5px; font-size: 12px; line-height: 1;
    }
    .sn-icon:hover { background: var(--surface-2); color: var(--text); }
    .sn-icon-danger:hover { color: var(--danger); }

    .sn-textarea {
      width: 100%; resize: vertical; min-height: 60px; border: 1px solid var(--border-strong);
      border-radius: 6px; padding: 8px; font-size: 13px; color: var(--text);
      background: var(--surface); font-family: inherit;
    }
    .sn-textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }

    .sn-card-actions { display: flex; gap: 8px; margin-top: 8px; }
    .sn-btn {
      border: 1px solid var(--border); background: var(--surface); color: var(--accent);
      border-radius: 999px; padding: 5px 14px; font-size: 12px; font-weight: 500; cursor: pointer;
    }
    .sn-btn:hover { background: var(--surface-2); }
    .sn-btn-primary { background: var(--accent); color: var(--accent-contrast); border-color: transparent; }
    .sn-btn-primary:hover { filter: brightness(0.96); background: var(--accent); }

    .sn-empty { color: var(--text-secondary); line-height: 1.5; padding: 8px 4px; }

    .sn-orphan-banner {
      background: color-mix(in srgb, var(--danger) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
      color: var(--text); border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.4;
    }
    .sn-orphan-row {
      margin-top: 8px; font-size: 12px; color: var(--text-secondary);
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .sn-orphan-hint { color: var(--text-faint); }

    /* Threaded replies */
    .sn-replies { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
    .sn-reply { border-left: 2px solid var(--border); padding: 3px 0 3px 8px; }
    .sn-reply-body { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.4; }
    .sn-reply-meta {
      display: flex; align-items: center; justify-content: space-between;
      color: var(--text-faint); font-size: 10.5px; margin-top: 2px;
    }
    .sn-reply-editing { border-left-color: var(--accent); }
    .sn-reply-add {
      margin-top: 8px; align-self: flex-start; border: none; background: transparent;
      color: var(--accent); cursor: pointer; font-size: 12px; padding: 0; font-weight: 500;
    }
    .sn-reply-add:hover { text-decoration: underline; }

    /* Per-note color */
    .sn-color-dot { font-size: 13px; line-height: 1; }
    .sn-palette { display: flex; gap: 6px; margin-top: 8px; }
    .sn-swatch {
      width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--border);
      cursor: pointer; padding: 0;
    }
    .sn-swatch:hover { transform: scale(1.12); }
    .sn-swatch.sel { box-shadow: 0 0 0 2px var(--accent); }

    .sn-foot {
      display: flex; gap: 16px; padding: 10px 14px; border-top: 1px solid var(--border);
      background: var(--surface);
    }
    .sn-link {
      border: none; background: transparent; color: var(--accent); cursor: pointer;
      font-size: 12px; padding: 0; text-decoration: none;
    }
    .sn-link:hover { text-decoration: underline; }

    .sn-fab {
      position: fixed; top: 50%; transform: translateY(-50%);
      display: flex; align-items: center; gap: 6px; z-index: 2147483646;
      border: 1px solid var(--border); background: var(--surface); color: var(--text);
      box-shadow: var(--shadow); cursor: grab; padding: 8px 10px; font-size: 14px;
      user-select: none;
    }
    .sn-fab:active { cursor: grabbing; }
    .sn-fab-right { right: 0; border-radius: 999px 0 0 999px; }
    .sn-fab-left { left: 0; border-radius: 0 999px 999px 0; }
    .sn-fab:hover { background: var(--surface-2); }
    .sn-fab-count {
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
      background: var(--accent); color: var(--accent-contrast);
      font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
    }

    .sn-add {
      position: absolute; z-index: 2147483647;
      background: var(--accent); color: var(--accent-contrast); border: none;
      border-radius: 999px; padding: 7px 12px; font-size: 12px; font-weight: 600;
      cursor: pointer; box-shadow: var(--shadow); white-space: nowrap;
    }
    .sn-add:hover { filter: brightness(0.96); }

    .sn-toast {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(8px);
      background: #323232; color: #fff; padding: 10px 16px; border-radius: 8px;
      font-size: 13px; z-index: 2147483647; opacity: 0; transition: opacity .15s, transform .15s;
      box-shadow: 0 4px 12px rgba(0,0,0,.3); pointer-events: none;
    }
    .sn-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  `;
})();
