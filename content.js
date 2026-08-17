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
  const EXT_VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_) {
      return "";
    }
  })();
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
  let focusPending = false; // focus the editor textarea on the next render only
  let hoverEditId = null; // note under the current selection (edit instead of add)
  const multiSelected = new Set(); // Shift+clicked cards (drives consolidation)
  let modifierHeld = false; // Option/Alt held → temporarily reveal a hidden tab
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
    const selString = sel.toString();
    if (!selString.trim()) return null;

    const range = sel.getRangeAt(0);
    const map = buildTextMap();
    let startG = globalOffsetOf(map, range.startContainer, range.startOffset);
    let endG = globalOffsetOf(map, range.endContainer, range.endOffset);

    // Fall back to locating the selection string when the boundaries aren't
    // clean text nodes (e.g. they land on element edges).
    if (startG == null || endG == null || endG <= startG) {
      const found = map.text.indexOf(selString);
      if (found === -1) return { type: "text", exact: selString, prefix: "", suffix: "", index: 0 };
      startG = found;
      endG = found + selString.length;
    }

    // Derive `exact` from our own text-node concatenation, NOT
    // Selection.toString() — the latter injects whitespace/newlines at element
    // boundaries that the concatenation lacks, which made multi-node selections
    // fail to re-anchor (they orphaned the instant they were created).
    const exact = map.text.slice(startG, endG);
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

  // Drop whitespace entirely, keeping a collapsed→raw index map. More tolerant
  // than collapsing (handles separators that exist on one side but not the
  // other, e.g. element boundaries after a reflow).
  function stripWhitespace(text) {
    let out = "";
    const idx = [];
    for (let i = 0; i < text.length; i += 1) {
      if (!/\s/.test(text[i])) {
        out += text[i];
        idx.push(i);
      }
    }
    return { text: out, idx };
  }

  function matchNormalized(map, normFull, exactStr) {
    if (!exactStr || exactStr.length < 3) return null;
    const at = normFull.text.indexOf(exactStr);
    if (at === -1) return null;
    const rawStart = normFull.idx[at];
    const rawEnd = normFull.idx[at + exactStr.length - 1] + 1;
    return rangeFromRawOffsets(map, rawStart, rawEnd);
  }

  // Fallback when the exact string no longer matches: try a whitespace-collapsed
  // search, then a whitespace-stripped search.
  function findRangeNormalized(map, anchor) {
    return (
      matchNormalized(map, collapseWhitespace(map.text), collapseWhitespace(anchor.exact).text.trim()) ||
      matchNormalized(map, stripWhitespace(map.text), stripWhitespace(anchor.exact).text)
    );
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
      // Translucent so the underlying text stays readable on any background.
      span.style.setProperty(
        "background-color",
        hexWithAlpha(color, settings.highlightOpacity),
        "important"
      );
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
  // Annotations live on TWO layers:
  //   #sn-doc-overlay — position:absolute at the document origin, so its
  //     contents are drawn in PAGE coordinates. An element's rect in document
  //     space doesn't change while scrolling, so this layer needs no work at all
  //     on scroll: the browser moves it natively and drawings stay glued to the
  //     content (this is what removes the "jumpy" lag).
  //   #sn-overlay — position:fixed, viewport coordinates. Only used for the
  //     live drawing preview and for anchors inside fixed/sticky containers,
  //     which genuinely do move relative to the document as you scroll.
  const overlayItems = []; // { comment, el|null }

  function overlayEl() {
    return shadow ? shadow.getElementById("sn-overlay") : null;
  }

  function docOverlayEl() {
    return shadow ? shadow.getElementById("sn-doc-overlay") : null;
  }

  // Fixed/sticky ancestors move with the viewport, so those anchors can't use
  // scroll-invariant page coordinates.
  function isViewportFixed(el) {
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === "fixed" || pos === "sticky") return true;
    }
    return false;
  }

  function clearOverlay() {
    overlayItems.length = 0;
    const fx = overlayEl();
    const doc = docOverlayEl();
    if (fx) fx.innerHTML = "";
    if (doc) doc.innerHTML = "";
  }

  function svgNode(name, attrs) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
    return n;
  }

  // Draw/position every overlay item. `fixedOnly` redraws just the viewport
  // layer — the document layer is scroll-invariant, so scrolling never touches
  // it (that's the whole point).
  function drawOverlay(fixedOnly) {
    const fx = overlayEl();
    const doc = docOverlayEl();
    if (!fx || !doc) return;
    // Preserve the in-flight preview, which lives on the fixed layer.
    const preview = Array.from(fx.querySelectorAll('[data-sidenote-id="__preview__"]'));
    fx.innerHTML = "";
    preview.forEach((n) => fx.appendChild(n));
    if (!fixedOnly) doc.innerHTML = "";

    const sx = window.scrollX;
    const sy = window.scrollY;

    overlayItems.forEach(({ comment, el, anchor, index }) => {
      // Page-anchored drawings are already in page coords → document layer.
      const pinned = el ? isViewportFixed(el) : false;
      if (fixedOnly && !pinned) return;
      const svg = pinned ? fx : doc;
      // Document layer needs viewport→page conversion; fixed layer does not.
      const ox = pinned ? 0 : sx;
      const oy = pinned ? 0 : sy;
      const color = comment.color || settings.highlightColor;

      if (anchor.type === "element" && el) {
        const r = el.getBoundingClientRect();
        svg.appendChild(
          svgNode("rect", {
            x: r.left + ox - 2, y: r.top + oy - 2, width: r.width + 4, height: r.height + 4,
            rx: 4, fill: "none", stroke: color, "stroke-width": 2,
            "stroke-dasharray": comment.resolved ? "4 3" : "0",
            class: "sn-ov-outline", "data-sidenote-id": comment.id
          })
        );
        svg.appendChild(
          svgNode("circle", {
            cx: r.right + ox, cy: r.top + oy, r: 9, fill: color, stroke: "#fff", "stroke-width": 2,
            class: "sn-ov-pin", "data-sidenote-id": comment.id
          })
        );
      } else if (anchor.type === "region") {
        const origin = el
          ? { left: el.getBoundingClientRect().left + ox, top: el.getBoundingClientRect().top + oy }
          : { left: 0, top: 0 }; // page coords, drawn straight onto the doc layer
        (anchor.shapes || []).forEach((shape) => drawShape(svg, comment, shape, origin, index));
      }
    });

    // Re-apply the on-page selection emphasis after a redraw.
    if (selectedNoteId) {
      [fx, doc].forEach((layer) =>
        layer
          .querySelectorAll(`[data-sidenote-id="${cssEscape(selectedNoteId)}"]`)
          .forEach((n) => n.classList.add("sn-ov-selected"))
      );
    }
  }

  function drawShape(svg, comment, shape, origin, anchorIndex) {
    const pts = shape.points.map((p) => ({ x: p.x + origin.left, y: p.y + origin.top }));
    const common = {
      fill: "none", stroke: shape.color, "stroke-width": shape.width,
      "stroke-linecap": "round", "stroke-linejoin": "round",
      class: "sn-ov-shape", "data-sidenote-id": comment.id,
      // Which of the note's anchors this shape belongs to, so dragging moves
      // only that drawing on a consolidated note.
      "data-sidenote-anchor": anchorIndex == null ? "" : String(anchorIndex)
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
  function scheduleOverlayRedraw(fixedOnly) {
    if (overlayRaf) return;
    overlayRaf = requestAnimationFrame(() => {
      overlayRaf = 0;
      drawOverlay(fixedOnly);
      // Cards live in the fixed panel, so they always realign with the viewport.
      layoutAligned();
    });
  }

  // Scroll: the document layer moves natively with the page, so only the
  // viewport-fixed layer (rare) and the aligned cards need any work.
  function onScrollRedraw() {
    scheduleOverlayRedraw(true);
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

  // The palette's buttons are built ONCE and then only have their state toggled.
  // Rebuilding innerHTML on every render destroyed the button between mousedown
  // and mouseup (renders are frequent on dynamic pages), so clicks — including
  // Done — silently never fired.
  function buildPaletteOnce(bar) {
    if (bar.firstChild) return;
    const tools = DRAW_TOOLS.map(
      (t) => `<button class="sn-tool" data-tool="${t.tool}" title="${t.title}">${t.glyph}</button>`
    ).join("");
    const swatches = DRAW_PALETTE.map(
      (c) => `<button class="sn-ink" style="background:${c}" data-drawcolor="${c}" title="${c}"></button>`
    ).join("");
    bar.innerHTML =
      `<div class="sn-tools">${tools}</div>` +
      `<div class="sn-inks">${swatches}</div>` +
      `<button class="sn-tool sn-palette-undo" data-tool="__undo" title="Undo (⌘Z / Ctrl+Z)">↶</button>` +
      `<button class="sn-palette-done" data-tool="__done" title="Close the palette (Esc)">Done</button>`;
  }

  function renderPalette() {
    if (!shadow) return;
    const bar = shadow.getElementById("sn-palette");
    if (!bar) return;
    bar.hidden = !paletteOpen;
    if (!paletteOpen) return;
    buildPaletteOnce(bar);
    if (!bar.style.top) bar.style.top = `${topInset + 12}px`;
    // In-place state only — never replace nodes while the user may be clicking.
    bar.querySelectorAll(".sn-tool[data-tool]").forEach((b) => {
      const t = b.dataset.tool;
      if (t.startsWith("__")) return;
      b.classList.toggle("sel", (drawTool || "select") === t);
    });
    bar.querySelectorAll(".sn-ink").forEach((b) => {
      b.classList.toggle("sel", b.dataset.drawcolor.toLowerCase() === drawColor().toLowerCase());
    });
    const undoBtn = bar.querySelector(".sn-palette-undo");
    if (undoBtn) undoBtn.disabled = !(undoStack.length > 0 || draft);
  }

  // Canvas-driven apps (Figma, Miro, map views) paint their content into a
  // <canvas> with no DOM to anchor to, and their pan/zoom is internal — there's
  // no signal we can observe. Annotations can't follow that content, so say so
  // once rather than silently misplacing them.
  let canvasWarned = false;
  function isCanvasApp() {
    const vw = window.innerWidth * window.innerHeight;
    if (!vw) return false;
    return Array.from(document.getElementsByTagName("canvas")).some((c) => {
      const r = c.getBoundingClientRect();
      return r.width * r.height > vw * 0.5;
    });
  }

  function openPalette() {
    paletteOpen = true;
    drawTool = null;
    syncCaptureLayer();
    render(); // also refreshes the header's pencil toggle state
    if (!canvasWarned && isCanvasApp()) {
      canvasWarned = true;
      showToast("This page draws its content in a canvas — notes can't follow it when you pan or zoom.");
    }
  }

  // Fully tear down the drawing UI: any in-progress stroke, the armed tool, and
  // the capture layer — so the palette can always be dismissed cleanly.
  function closePalette() {
    endStroke();
    paletteOpen = false;
    drawTool = null;
    syncCaptureLayer();
    render();
  }

  function endStroke() {
    document.removeEventListener("mousemove", onDrawMove, true);
    document.removeEventListener("mouseup", onDrawEnd, true);
    drawing = null;
    clearPreview();
  }

  function syncCaptureLayer() {
    if (!shadow) return;
    const cap = shadow.getElementById("sn-draw-capture");
    if (cap) cap.hidden = !drawTool;
  }

  function setTool(tool) {
    drawTool = DRAW_TOOLS.some((t) => t.tool === tool) && tool !== "select" ? tool : null;
    syncCaptureLayer();
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
    // Keep the tool armed so several shapes can be drawn in succession; the note
    // is already saved, and text can be added at any time.
    createNote(anchor, { keepFocus: false });
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
    // A note can carry several anchors; it's only orphaned if none resolve.
    renderList().forEach((c) => {
      let placed = 0;
      (c.anchors || []).forEach((a, i) => {
        const type = a.type || "text";
        if (type === "text") {
          const range = findRange(a);
          if (range && highlightRange(range, c).length > 0) placed += 1;
        } else if (type === "element") {
          const el = findElement(a.target);
          if (el) {
            overlayItems.push({ comment: c, el, anchor: a, index: i });
            placed += 1;
          }
        } else if (type === "region") {
          const el = a.relativeTo === "element" ? findElement(a.target) : null;
          if (a.relativeTo === "element" && !el) return;
          overlayItems.push({ comment: c, el, anchor: a, index: i });
          placed += 1;
        }
      });
      if (placed === 0) orphaned.add(c.id);
    });
    drawOverlay();
    return orphaned;
  }

  // Every element the note's highlight/pin/shape maps to, for scroll + emphasis.
  function targetsFor(id) {
    const sel = `[data-sidenote-id="${cssEscape(id)}"]`;
    let out = Array.from(document.querySelectorAll(`.__sidenote_hl${sel}`));
    [overlayEl(), docOverlayEl()].forEach((layer) => {
      if (layer) out = out.concat(Array.from(layer.querySelectorAll(sel)));
    });
    return out;
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
    // Linked notes are kept adjacent (matters for the list layout; the aligned
    // layout positions by anchor).
    return orderLinked(renderList().filter((c) => panelSideFor(c) === side));
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
      <svg id="sn-doc-overlay" class="sn-doc-overlay"></svg>
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
    // Autosave note text as it's typed (debounced) so nothing is lost if the
    // user navigates, closes the panel, or starts another note.
    chromeEl.addEventListener("input", (e) => {
      if (e.target.classList && e.target.classList.contains("sn-textarea")) scheduleBodySave();
      // Live preview while dragging in the native colour picker.
      if (e.target.classList && e.target.classList.contains("sn-color-input")) {
        setColor(e.target.dataset.id, e.target.value, true);
      }
    });
    // Cmd/Ctrl+Enter saves the note or reply being edited.
    chromeEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      const ta = e.target.closest && e.target.closest(".sn-textarea");
      if (!ta) return;
      e.preventDefault();
      saveEdit(ta.dataset.id);
      render();
    });
    chromeEl.addEventListener("change", (e) => {
      if (e.target.classList && e.target.classList.contains("sn-color-input")) {
        setColor(e.target.dataset.id, e.target.value);
        render();
      }
    });
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

    // Keep key events typed inside our UI from reaching the page — otherwise a
    // site's global shortcuts (e.g. GitHub's single-key hotkeys) fire while the
    // user is typing a note. Our own shortcuts listen on document in the capture
    // phase, which runs before this bubble-phase stop, so they still work.
    ["keydown", "keyup", "keypress"].forEach((type) =>
      shadow.addEventListener(type, (e) => e.stopPropagation())
    );

    // Overlay pins/outlines/shapes (both layers): click → select + focus card.
    [shadow.getElementById("sn-overlay"), shadow.getElementById("sn-doc-overlay")].forEach((svg) => {
      svg.addEventListener("mousedown", onShapeDragStart);
      svg.addEventListener("click", (e) => {
        const id = e.target.getAttribute && e.target.getAttribute("data-sidenote-id");
        if (!id || id === "__preview__" || shapeDragged) return;
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
    });

    // Floating delete for the selected drawing/pin.
    shadow.getElementById("sn-shape-menu").addEventListener("click", () => {
      const id = selectedNoteId;
      selectShape(null);
      if (id) deleteComment(id);
    });
  }

  // Drag a drawing to reposition it. Only when no draw tool is armed (the
  // capture layer would otherwise swallow the press). Shapes translate live and
  // the new points are committed on release.
  let shapeDragged = false;
  function onShapeDragStart(e) {
    if (drawTool) return; // drawing mode owns the pointer
    const id = e.target.getAttribute && e.target.getAttribute("data-sidenote-id");
    if (!id || id === "__preview__") return;
    const c = comments.find((x) => x.id === id);
    if (!c) return;
    const ai = Number(e.target.getAttribute("data-sidenote-anchor"));
    const anchor = (c.anchors || [])[Number.isFinite(ai) ? ai : 0];
    if (!anchor || anchor.type !== "region") return; // only drawings move

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const nodes = targetsFor(id).filter((n) => n.namespaceURI === "http://www.w3.org/2000/svg");

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      nodes.forEach((n) => n.setAttribute("transform", `translate(${dx} ${dy})`));
    };
    const onUp = (ev) => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      if (!moved) return;
      shapeDragged = true;
      setTimeout(() => (shapeDragged = false), 0); // swallow the trailing click
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      nodes.forEach((n) => n.removeAttribute("transform"));
      (anchor.shapes || []).forEach((sh) => {
        sh.points = sh.points.map((p) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }));
      });
      c.updatedAt = Date.now();
      mutatePage((entry) => {
        const t = (entry.comments || []).find((x) => x.id === id);
        if (t) {
          t.anchors = c.anchors;
          t.updatedAt = c.updatedAt;
        }
      });
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  // Select an on-page drawing/pin so it can be deleted (Del key or the menu).
  function selectShape(id, x, y) {
    selectedNoteId = id || null;
    [overlayEl(), docOverlayEl()].forEach((svg) => {
      if (!svg) return;
      svg.querySelectorAll(".sn-ov-selected").forEach((n) => n.classList.remove("sn-ov-selected"));
      if (id) {
        svg.querySelectorAll(`[data-sidenote-id="${cssEscape(id)}"]`).forEach((n) => n.classList.add("sn-ov-selected"));
      }
    });
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

  // Formatting is stored as Markdown (**bold**, *italic*, ~~strike~~) rather
  // than HTML: it round-trips through the Markdown/CSV/plaintext exports, and
  // rendering stays safe because we escape first and only then apply these.
  function renderBody(text) {
    return esc(text)
      .replace(/\*\*([^\n*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^\n*]+)\*/g, "$1<em>$2</em>")
      .replace(/~~([^\n~]+)~~/g, "<del>$1</del>");
  }

  function formatBarHtml(id) {
    const btn = (fmt, label, title) =>
      `<button class="sn-fmt" data-action="format" data-fmt="${fmt}" data-id="${esc(id)}" title="${title}">${label}</button>`;
    return `<div class="sn-fmt-bar">
        ${btn("bold", "<strong>B</strong>", "Bold")}
        ${btn("italic", "<em>I</em>", "Italic")}
        ${btn("strike", "<del>S</del>", "Strikethrough")}
      </div>`;
  }

  // Wrap the textarea's selection in the given Markdown markers.
  function applyFormat(id, fmt) {
    const ta = shadow.querySelector(`.sn-textarea[data-id="${cssEscape(id)}"]`);
    if (!ta) return;
    const marks = { bold: "**", italic: "*", strike: "~~" };
    const m = marks[fmt];
    if (!m) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const chosen = ta.value.slice(start, end) || "text";
    ta.value = ta.value.slice(0, start) + m + chosen + m + ta.value.slice(end);
    ta.focus();
    ta.setSelectionRange(start + m.length, start + m.length + chosen.length);
    scheduleBodySave();
  }

  function editorHtml(id, value, placeholder, kind) {
    // A root note in auto-save mode is already persisted, so its editor offers
    // Done (close) and Delete rather than Save/Cancel. Replies and explicit-save
    // notes keep Save/Cancel.
    const auto = kind === "note" && !settings.requireExplicitSave;
    const primary = auto ? "Done" : "Save";
    const secondary = auto
      ? `<button class="sn-btn sn-btn-danger" data-action="delete" data-id="${esc(id)}">Delete</button>`
      : `<button class="sn-btn" data-action="cancel" data-id="${esc(id)}">Cancel</button>`;
    return `${formatBarHtml(id)}
      <textarea class="sn-textarea" data-id="${esc(id)}" placeholder="${esc(placeholder)}" rows="3">${esc(value || "")}</textarea>
      <div class="sn-card-actions">
        <button class="sn-btn sn-btn-primary" data-action="save" data-id="${esc(id)}">${primary}</button>
        ${secondary}
      </div>`;
  }

  function repliesForCard(c) {
    const drafted = replyDraft && replyDraft.commentId === c.id ? [replyDraft.reply] : [];
    return (c.replies || []).concat(drafted);
  }

  function replyHtml(comment, reply) {
    if (reply.id === editingId) {
      return `<div class="sn-reply sn-reply-editing">${editorHtml(reply.id, reply.body, "Write a reply…", "reply")}</div>`;
    }
    return `<div class="sn-reply">
        <div class="sn-reply-body">${renderBody(reply.body)}</div>
        <div class="sn-reply-meta">
          <span>${esc(formatTime(reply.updatedAt || reply.createdAt))}</span>
          <span class="sn-card-tools">
            <button class="sn-icon" title="Edit reply" data-action="edit-reply" data-id="${esc(reply.id)}">✎</button>
            <button class="sn-icon sn-icon-danger" title="Delete reply" data-action="delete-reply" data-id="${esc(reply.id)}" data-comment="${esc(comment.id)}">🗑</button>
          </span>
        </div>
      </div>`;
  }

  // A drawing's colour lives on its shapes; text/element notes carry their own.
  function noteColor(c) {
    const region = (c.anchors || []).find((a) => a.type === "region");
    if (region) {
      const shape = (region.shapes || [])[0];
      if (shape && shape.color) return shape.color;
    }
    return c.color || settings.highlightColor;
  }

  function paletteHtml(c) {
    const current = noteColor(c);
    const preset = HIGHLIGHT_PALETTE.some((col) => col.toLowerCase() === current.toLowerCase());
    const swatches = HIGHLIGHT_PALETTE.map(
      (col) =>
        `<button class="sn-swatch${col.toLowerCase() === current.toLowerCase() ? " sel" : ""}" style="background:${col}" title="${col}" data-action="set-color" data-id="${esc(c.id)}" data-color="${col}"></button>`
    ).join("");
    // Custom colour: same round shape, filled with the classic rainbow wheel,
    // opening the native picker.
    const custom =
      `<button class="sn-swatch sn-swatch-custom${preset ? "" : " sel"}" title="Custom colour" data-action="custom-color" data-id="${esc(c.id)}"></button>` +
      `<input class="sn-color-input" type="color" value="${esc(current)}" data-id="${esc(c.id)}" aria-hidden="true" tabindex="-1" />`;
    return `<div class="sn-palette">${swatches}${custom}</div>`;
  }

  // The head of a card: a quote for text notes, a typed descriptor for element
  // and drawing notes.
  function anchorHeadHtml(c) {
    const a = primaryAnchor(c) || {};
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
    const color = noteColor(c);
    const classes = ["sn-card"];
    if (c.resolved) classes.push("sn-card-resolved");
    if (orphaned) classes.push("sn-card-orphan");
    if (editingRoot) classes.push("sn-card-editing");
    if (multiSelected.has(c.id)) classes.push("sn-card-multi");

    const head = anchorHeadHtml(c);

    // Editing the root note (also the state for a brand-new draft).
    if (editingRoot) {
      return `<article class="${classes.join(" ")}" data-id="${esc(c.id)}">
          ${head}
          ${editorHtml(c.id, c.body, "Add your note…", "note")}
        </article>`;
    }

    const bodyBlock = `<div class="sn-body">${c.body ? renderBody(c.body) : '<span class="sn-body-empty">No note text</span>'}</div>`;

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
          ${c.linkGroup ? `<button class="sn-icon" title="Go to next linked note" data-action="next-linked" data-id="${esc(c.id)}">🔗</button>` : ""}
          ${sidesInUse().length > 1 ? `<button class="sn-icon" title="Move to other side" data-action="flip" data-id="${esc(c.id)}">⇄</button>` : ""}
          <button class="sn-icon" title="Edit note" data-action="edit" data-id="${esc(c.id)}">✎</button>
          <button class="sn-icon sn-icon-danger" title="Delete note" data-action="delete" data-id="${esc(c.id)}">🗑</button>
        </span>
      </div>`;
    const palette = colorPickerId === c.id ? paletteHtml(c) : "";

    const isText = ((primaryAnchor(c) || {}).type || "text") === "text";
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
          <button class="sn-brand" data-action="all-notes" title="Open All notes">
            <span class="sn-brand-mark">▎</span> SideNote
          </button>
          <div class="sn-head-tools">
            <button class="sn-icon${paletteOpen ? " sel" : ""}" title="Draw on page" data-action="draw">✎</button>
            <span class="sn-count">${list.filter((c) => !c.resolved).length}</span>
            <button class="sn-icon" title="Close panel" data-action="close" data-side="${side}">✕</button>
          </div>
        </header>
        ${
          multiSelected.size
            ? `<div class="sn-multibar">
                 <span>${multiSelected.size} selected</span>
                 <span class="sn-multibar-actions">
                   ${multiSelected.size > 1 ? `<button class="sn-link" data-action="consolidate">Consolidate</button>` : ""}
                   ${multiSelected.size > 1 ? `<button class="sn-link" data-action="link">Link</button>` : ""}
                   <button class="sn-link" data-action="clear-multi">Clear</button>
                 </span>
               </div>`
            : ""
        }
        <div class="sn-cards${aligned ? " sn-cards-aligned" : ""}">${cards}</div>
        <footer class="sn-foot sn-foot-${side}">
          <button class="sn-link" data-action="settings">Settings</button>
          <button class="sn-link sn-version" data-action="changelog" title="View the changelog">v${esc(EXT_VERSION)}</button>
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
    // Preserve in-progress edit text across the full rebuild below (a data
    // change or re-anchor shouldn't wipe what the user is typing).
    if (editingId) {
      const prevTa = shadow.querySelector(`.sn-textarea[data-id="${cssEscape(editingId)}"]`);
      if (prevTa) {
        if (draft && draft.id === editingId) draft.body = prevTa.value;
        else {
          const c = comments.find((x) => x.id === editingId);
          if (c) c.body = prevTa.value;
          else {
            const r = findReply(editingId);
            if (r) r.reply.body = prevTa.value;
          }
        }
      }
    }
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
      } else if (settings.showTab || modifierHeld) {
        const count = commentsForSide(side).filter((c) => !c.resolved).length;
        html += fabHtml(side, count);
      }
    });
    chromeEl.innerHTML = html;
    applyPush();
    renderPalette();
    shadow.getElementById("sn-draw-capture").hidden = !drawTool;
    layoutAligned();

    // Focus the editor only when it was just opened, so incidental re-renders
    // (re-anchor, data changes) don't steal focus mid-typing.
    if (editingId && focusPending) {
      const ta = shadow.querySelector(`.sn-textarea[data-id="${cssEscape(editingId)}"]`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        focusPending = false;
      }
    }
  }

  // Aligned layout: each card sits at its anchor's vertical position (panel-
  // relative). Cards whose anchor is scrolled out of view are hidden (so they
  // don't cascade and crowd the top while scrolling); notes that can't be placed
  // (orphaned) sit in a compact pinned stack at the top. Anchored cards use a
  // collision push-down starting below that stack.
  function layoutAligned() {
    if (!shadow || settings.sidebarLayout !== "aligned") return;
    const GAP = 8;
    shadow.querySelectorAll(".sn-cards-aligned").forEach((body) => {
      const bodyTop = body.getBoundingClientRect().top;
      const bodyH = body.clientHeight || body.getBoundingClientRect().height;
      const anchored = [];
      const unplaced = [];
      Array.from(body.querySelectorAll(".sn-card")).forEach((card) => {
        const t = targetsFor(card.dataset.id)[0];
        const h = card.offsetHeight;
        if (t) anchored.push({ card, desired: t.getBoundingClientRect().top - bodyTop, h });
        else unplaced.push({ card, h });
      });

      // Position with `transform` rather than `top`: it's compositor-friendly,
      // so per-scroll repositioning doesn't force a layout pass (less jitter).
      const place = (card, y) => {
        card.style.display = "";
        card.style.transform = `translateY(${Math.round(y)}px)`;
      };

      // Unplaced (couldn't be located) → compact stack pinned at the top.
      let pileBottom = 0;
      unplaced.forEach((it) => {
        place(it.card, pileBottom);
        pileBottom += it.h + GAP;
      });

      // Anchored → aligned; hide those scrolled out of view so they don't pile.
      anchored.sort((a, b) => a.desired - b.desired);
      let prevBottom = pileBottom - GAP;
      anchored.forEach((it) => {
        if (it.desired + it.h < pileBottom || it.desired > bodyH) {
          it.card.style.display = "none";
          return;
        }
        const y = Math.max(it.desired, prevBottom + GAP);
        place(it.card, y);
        prevBottom = y + it.h;
      });
    });
  }

  /* -------------------------------------------------- Chrome actions */
  function onChromeClick(e) {
    // Shift+click toggles a card's selection (for consolidating/reordering)
    // rather than triggering whatever control was under the pointer.
    if (e.shiftKey) {
      const card = e.target.closest(".sn-card");
      if (card) {
        e.preventDefault();
        e.stopPropagation();
        const id = card.dataset.id;
        if (multiSelected.has(id)) multiSelected.delete(id);
        else multiSelected.add(id);
        render();
        return;
      }
    }
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
        focusPending = true;
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
        focusPending = true;
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
      case "format":
        applyFormat(id, el.dataset.fmt);
        break;
      case "clear-multi":
        multiSelected.clear();
        render();
        break;
      case "consolidate":
        consolidateSelected();
        break;
      case "link":
        linkSelected();
        break;
      case "next-linked":
        gotoNextLinked(id);
        break;
      case "custom-color": {
        // Open the browser's own colour picker via the paired hidden input.
        const input = shadow.querySelector(`.sn-color-input[data-id="${cssEscape(id)}"]`);
        if (input) input.click();
        break;
      }
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
      case "changelog":
        chrome.runtime.sendMessage({ type: "sn-open-tab", page: "changelog.html" });
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
    } else if (c && (primaryAnchor(c) || {}).type !== "text") {
      const pa = primaryAnchor(c) || {};
      const el = pa.type === "element" || pa.relativeTo === "element" ? findElement(pa.target) : null;
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
    focusPending = true;
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

  function setColor(commentId, color, keepOpen) {
    if (!/^#([A-Fa-f0-9]{6})$/.test(String(color || ""))) return;
    if (!keepOpen) colorPickerId = null;
    const c = comments.find((x) => x.id === commentId) || (draft && draft.id === commentId ? draft : null);
    if (!c) return;
    c.color = color;
    // For a drawing, the visible colour is its ink — recolour the shapes too.
    (c.anchors || []).forEach((a) => {
      if (a.type === "region") (a.shapes || []).forEach((sh) => (sh.color = color));
    });
    if (draft && draft.id === commentId) {
      render();
      return;
    }
    mutatePage((e) => {
      const target = (e.comments || []).find((x) => x.id === commentId);
      if (!target) return;
      target.color = color;
      (target.anchors || []).forEach((a) => {
        if (a.type === "region") (a.shapes || []).forEach((sh) => (sh.color = color));
      });
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

  /* -------------------------------------------- Consolidate & link */
  // Merge the selected notes into one that points at all of their page
  // annotations. Bodies are joined with a plain `---` line, which is just text
  // in the merged note, so it can be edited away or replaced.
  function consolidateSelected() {
    const picked = comments.filter((c) => multiSelected.has(c.id));
    if (picked.length < 2) return;
    picked.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    const keep = picked[0];
    const rest = picked.slice(1);
    const before = picked.map((c) => JSON.parse(JSON.stringify(c)));

    const merged = {
      ...keep,
      anchors: picked.reduce((acc, c) => acc.concat(c.anchors || []), []),
      body: picked.map((c) => c.body).filter(Boolean).join("\n\n---\n\n"),
      replies: picked.reduce((acc, c) => acc.concat(c.replies || []), []),
      updatedAt: Date.now()
    };
    delete merged.linkGroup; // one note can't be linked to its former selves

    const removedIds = rest.map((c) => c.id);
    comments = comments.filter((c) => !removedIds.includes(c.id)).map((c) => (c.id === keep.id ? merged : c));
    multiSelected.clear();
    pushUndo({ kind: "restore", comments: before, addedId: merged.id });
    mutatePage((e) => {
      e.comments = (e.comments || [])
        .filter((c) => !removedIds.includes(c.id))
        .map((c) => (c.id === keep.id ? merged : c));
    });
    showToast(`Consolidated ${picked.length} notes.`);
  }

  // Link the selected notes: they share a group, stay adjacent in listings, and
  // each gets a 🔗 that steps to the next one.
  function linkSelected() {
    const picked = comments.filter((c) => multiSelected.has(c.id));
    if (picked.length < 2) return;
    const before = picked.map((c) => JSON.parse(JSON.stringify(c)));
    // Reuse an existing group if any of the selection already belongs to one.
    const group = picked.find((c) => c.linkGroup)?.linkGroup || genId("grp");
    const ids = picked.map((c) => c.id);
    comments.forEach((c) => {
      if (ids.includes(c.id)) c.linkGroup = group;
    });
    multiSelected.clear();
    pushUndo({ kind: "restore", comments: before });
    mutatePage((e) => {
      (e.comments || []).forEach((c) => {
        if (ids.includes(c.id)) c.linkGroup = group;
      });
    });
    showToast(`Linked ${picked.length} notes.`);
  }

  // Step to the next note in this one's link group (wrapping around).
  function gotoNextLinked(id) {
    const c = comments.find((x) => x.id === id);
    if (!c || !c.linkGroup) return;
    const group = orderLinked(comments).filter((x) => x.linkGroup === c.linkGroup);
    if (group.length < 2) return;
    const next = group[(group.findIndex((x) => x.id === id) + 1) % group.length];
    gotoHighlight(next.id);
    focusCard(next.id);
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
    if (action.kind === "restore" && Array.isArray(action.comments)) {
      // Undo a consolidate/link: drop anything it created and put the
      // originals back exactly as they were.
      const ids = action.comments.map((c) => c.id);
      comments = comments.filter((c) => !ids.includes(c.id) && c.id !== action.addedId).concat(action.comments);
      mutatePage((e) => {
        e.comments = (e.comments || [])
          .filter((c) => !ids.includes(c.id) && c.id !== action.addedId)
          .concat(action.comments);
      });
    } else if (action.kind === "add") {
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
      // Selecting text that's already highlighted should edit that note rather
      // than stack a second one on top of it.
      hoverEditId = noteIdForSelection(sel);
      pendingRect = rect;
      showAddButton(rect);
    });
  }

  // The note whose highlight the selection sits inside, if any.
  function noteIdForSelection(sel) {
    const inHighlight = (node) => {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const hl = el && el.closest && el.closest(".__sidenote_hl");
      return hl ? hl.getAttribute("data-sidenote-id") : null;
    };
    return inHighlight(sel.anchorNode) || inHighlight(sel.focusNode);
  }

  function showAddButton(rect) {
    if (!shadow) return;
    const btn = shadow.getElementById("sn-add");
    btn.hidden = false;
    btn.textContent = reanchorId
      ? "↪ Re-anchor here"
      : hoverEditId
      ? "✏️ Edit note"
      : "💬 Add note";
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
    hoverEditId = null;
  }

  function onAddClick() {
    // Selection inside an existing highlight → edit that note.
    if (hoverEditId && !reanchorId) {
      const id = hoverEditId;
      hideAddButton();
      const sel0 = window.getSelection();
      if (sel0) sel0.removeAllRanges();
      editingId = id;
      focusPending = true;
      colorPickerId = null;
      focusCard(id);
      return;
    }
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
    c.anchors = [anchor].concat((c.anchors || []).slice(1));
    c.updatedAt = Date.now();
    mutatePage((e) => {
      const target = (e.comments || []).find((x) => x.id === id);
      if (target) {
        target.anchors = c.anchors;
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

  // Debounced autosave while typing. Keeps a persisted note's text current
  // without waiting for Save/Done (a draft in explicit-save mode stays local).
  let bodySaveTimer = null;
  function scheduleBodySave() {
    if (settings.requireExplicitSave) return;
    clearTimeout(bodySaveTimer);
    bodySaveTimer = setTimeout(flushEditingBody, 400);
  }

  // Flush the text of the note currently being edited into storage (auto-save
  // mode). Called before creating another note and when leaving the page, so
  // typed text is never lost even though there's no explicit Save.
  function flushEditingBody() {
    if (!editingId || !shadow) return;
    const ta = shadow.querySelector(`.sn-textarea[data-id="${cssEscape(editingId)}"]`);
    if (!ta) return;
    const body = ta.value.trim();
    const c = comments.find((x) => x.id === editingId);
    if (!c) return;
    // Always write through: render() mirrors in-progress text into the local
    // model to preserve it across rebuilds, so comparing against `c.body` would
    // wrongly conclude there's nothing to persist.
    const id = editingId;
    c.body = body;
    c.updatedAt = Date.now();
    mutatePage((e) => {
      const t = (e.comments || []).find((x) => x.id === id);
      if (t) {
        t.body = body;
        t.updatedAt = c.updatedAt;
      }
    });
  }

  // The single note-creation pipeline. Every trigger (the selection button, the
  // context menu, the keyboard command, the drawing tools) funnels through here.
  function createNote(anchor, opts) {
    if (!active) return;
    // Save the text of any note being edited so switching to a new anchor never
    // loses it.
    if (!settings.requireExplicitSave) flushEditingBody();
    const o = opts || {};
    const inUse = sidesInUse();
    const side = o.side && inUse.includes(o.side)
      ? o.side
      : inUse.includes(settings.defaultSides)
      ? settings.defaultSides
      : inUse.includes("right")
      ? "right"
      : inUse[0];
    const note = {
      id: genId("note"),
      anchors: [anchor],
      body: "",
      side,
      color: o.color || settings.highlightColor,
      resolved: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      replies: []
    };
    editingId = note.id;
    // Drawing in succession shouldn't yank focus into the editor each time.
    focusPending = o.keepFocus !== false;
    colorPickerId = null;
    open[panelSideFor(note)] = true;
    if (settings.requireExplicitSave) {
      // Provisional until Saved.
      draft = note;
      render();
    } else {
      // Persist immediately — a note is never lost, even with no text.
      draft = null;
      comments.push(note);
      pushUndo({ kind: "add", id: note.id });
      mutatePage((e) => {
        e.enabled = true;
        e.comments = (e.comments || []).filter((c) => c.id !== note.id).concat([note]);
      });
      render();
    }
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
      if (active) reanchorOnly();
    }, 300);
  }

  // Re-place highlights/pins/drawings (and realign cards) WITHOUT rebuilding the
  // panel — so a late-content re-anchor never wipes a note the user is editing.
  function reanchorOnly() {
    if (!shadow) return;
    if (domObserver) domObserver.disconnect();
    const orphaned = renderAnnotations();
    lastOrphanCount = orphaned.size;
    if (domObserver && document.body) {
      domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    layoutAligned();
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
    // Click a text highlight → open its note for editing.
    const hl = e.target.closest && e.target.closest(".__sidenote_hl");
    if (hl && active) {
      const id = hl.getAttribute("data-sidenote-id");
      editingId = id;
      focusPending = true;
      colorPickerId = null;
      focusCard(id);
    }
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
      onScrollRedraw();
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
  // Leaving the page saves in-progress note text (best-effort) when auto-save is on.
  window.addEventListener("pagehide", () => {
    if (!settings.requireExplicitSave) flushEditingBody();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "sync" && changes[SETTINGS_KEY]) || (area === "local" && changes[PAGES_KEY])) {
      reload();
    }
  });

  prefersDark.addEventListener("change", () => {
    if (active && settings.theme === "auto") render();
  });

  // Releasing Option/Alt (or leaving the page) hides a temporarily-revealed tab.
  function releaseModifier() {
    if (!modifierHeld) return;
    modifierHeld = false;
    if (active) render();
  }
  document.addEventListener("keyup", (e) => {
    if (e.key === "Alt") releaseModifier();
  }, true);
  window.addEventListener("blur", releaseModifier);

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
        // Typing in a note? Esc closes that editor first (auto-save keeps the
        // text; explicit-save discards an unsaved draft).
        if (editingId && isEditableFocused()) {
          if (settings.requireExplicitSave) cancelEdit();
          else {
            flushEditingBody();
            editingId = null;
          }
          render();
        } else if (multiSelected.size) {
          multiSelected.clear();
          render();
        } else if (reanchorId) {
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

      // Holding Option/Alt temporarily reveals a hidden margin tab.
      if (e.key === "Alt" && !settings.showTab && settings.revealTabOnModifier && !modifierHeld) {
        modifierHeld = true;
        render();
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
    .sn-brand {
      font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 6px;
      background: none; border: none; padding: 0; color: var(--text); cursor: pointer;
      font-family: inherit;
    }
    .sn-brand:hover { color: var(--accent); }
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
    .sn-cards-aligned .sn-card { position: absolute; top: 0; left: 12px; right: 12px; will-change: transform; }
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
    .sn-card-multi { box-shadow: 0 0 0 2px var(--accent); }
    .sn-multibar-actions { display: flex; gap: 10px; }
    .sn-multibar {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      flex-wrap: wrap;
      padding: 6px 14px; font-size: 12px; color: var(--text-secondary);
      background: var(--surface-2); border-bottom: 1px solid var(--border);
    }
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
    /* Document-coordinate layer: anchored at the document origin with zero size
       and overflow visible, so it can paint anywhere on the page without
       affecting layout or the scroll extent — and scrolls natively with it. */
    .sn-doc-overlay {
      position: absolute; top: 0; left: 0; width: 0; height: 0;
      overflow: visible; pointer-events: none; z-index: 2147483645;
    }
    .sn-overlay .sn-ov-pin, .sn-overlay .sn-ov-outline, .sn-overlay .sn-ov-shape,
    .sn-doc-overlay .sn-ov-pin, .sn-doc-overlay .sn-ov-outline, .sn-doc-overlay .sn-ov-shape {
      pointer-events: auto; cursor: pointer;
    }
    .sn-ov-active, .sn-ov-flash { filter: drop-shadow(0 0 3px var(--accent)); }
    .sn-ov-selected { filter: drop-shadow(0 0 4px var(--accent)); stroke-dasharray: 5 3; }
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
    .sn-btn-danger { color: var(--danger); }

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
    /* Custom colour: the classic rainbow wheel, same round shape as the presets. */
    .sn-swatch-custom {
      background: conic-gradient(#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000);
      position: relative;
    }
    .sn-swatch-custom::after {
      content: ""; position: absolute; inset: 4px; border-radius: 50%;
      background: radial-gradient(circle, rgba(255,255,255,.95), rgba(255,255,255,0) 70%);
    }
    .sn-color-input { position: absolute; width: 0; height: 0; opacity: 0; border: none; padding: 0; }

    /* Formatting toolbar above a note's editor */
    .sn-fmt-bar { display: flex; gap: 4px; margin-bottom: 6px; }
    .sn-fmt {
      min-width: 24px; height: 24px; border-radius: 5px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text-secondary); cursor: pointer;
      font-size: 12px; line-height: 1; padding: 0 6px;
    }
    .sn-fmt:hover { background: var(--surface-2); color: var(--text); }
    .sn-body strong, .sn-reply-body strong { font-weight: 700; }
    .sn-body del, .sn-reply-body del { opacity: 0.75; }

    .sn-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 10px 14px; border-top: 1px solid var(--border); background: var(--surface);
    }
    /* Settings sits on the panel's outer edge: left in the left bar, right in
       the right bar (the version line takes the inner edge). */
    .sn-foot-left { flex-direction: row; }
    .sn-foot-right { flex-direction: row-reverse; }
    .sn-version { color: var(--text-faint); font-size: 11px; }
    .sn-version:hover { color: var(--accent); }
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
