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
  let active = false; // is SideNote live on this page?
  const open = { left: false, right: false }; // which panels are expanded

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
    if (positions.length === 0) return null;

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
  // Build a resilient locator for an element (Phase 1 will create these; the
  // renderer below already consumes them so element notes round-trip now).
  function xPathOf(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `//*[@id="${el.id}"]`;
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      let i = 1;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === node.tagName) i += 1;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${i}]`);
      if (node.tagName === "BODY") break;
    }
    return `/${parts.join("/")}`;
  }

  function buildTarget(el) {
    const rect = el.getBoundingClientRect();
    const nth = el.tagName ? Array.from(document.getElementsByTagName(el.tagName)).indexOf(el) : 0;
    return {
      selector: el.id ? `#${el.id}` : "",
      xpath: xPathOf(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      classes: Array.from(el.classList || []),
      textHint: (el.textContent || "").trim().slice(0, 60),
      attrHint: el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || el.value || "",
      nthOfType: Math.max(0, nth),
      rect: { w: Math.round(rect.width), h: Math.round(rect.height) }
    };
  }

  // Re-find a linked element by scoring candidate matches.
  function findElement(target) {
    if (!target) return null;
    if (target.selector) {
      const bySel = document.querySelector(target.selector);
      if (bySel) return bySel;
    }
    if (target.xpath) {
      try {
        const r = document.evaluate(target.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (r.singleNodeValue) return r.singleNodeValue;
      } catch (_) {
        /* malformed xpath */
      }
    }
    // Fuzzy fallback: score every element of the same tag.
    const candidates = target.tag ? Array.from(document.getElementsByTagName(target.tag)) : [];
    let best = null;
    let bestScore = 0;
    candidates.forEach((el) => {
      if (el.closest(`#${HOST_ID}`)) return;
      let score = 0;
      if (target.id && el.id === target.id) score += 5;
      if (target.textHint && (el.textContent || "").trim().slice(0, 60) === target.textHint) score += 3;
      const attr = el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || el.value || "";
      if (target.attrHint && attr === target.attrHint) score += 3;
      const cls = Array.from(el.classList || []);
      const shared = target.classes.filter((c) => cls.includes(c)).length;
      score += Math.min(shared, 3);
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
        const origin = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
        (comment.anchor.shapes || []).forEach((shape) => drawShape(svg, comment, shape, origin));
      }
    });
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
    });
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
      if ((e.comments || []).length === 0 && e.enabled !== true) {
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
      <svg id="sn-overlay" class="sn-overlay"></svg>
      <div id="sn-chrome"></div>
      <button id="sn-add" class="sn-add" type="button" hidden>💬 Add note</button>
      <div id="sn-toast" class="sn-toast" hidden></div>`;
    (document.documentElement || document.body).appendChild(hostEl);

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

    // Overlay pins/outlines/shapes: click → focus card, hover → emphasize card.
    const svg = shadow.getElementById("sn-overlay");
    svg.addEventListener("click", (e) => {
      const id = e.target.getAttribute && e.target.getAttribute("data-sidenote-id");
      if (id) focusCard(id);
    });
    svg.addEventListener("mouseover", (e) => {
      const id = e.target.getAttribute && e.target.getAttribute("data-sidenote-id");
      if (id) emphasizeCard(id, true);
    });
    svg.addEventListener("mouseout", (e) => {
      const id = e.target.getAttribute && e.target.getAttribute("data-sidenote-id");
      if (id) emphasizeCard(id, false);
    });
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
          <button class="sn-icon" title="Move to other side" data-action="flip" data-id="${esc(c.id)}">⇄</button>
          <button class="sn-icon" title="Edit note" data-action="edit" data-id="${esc(c.id)}">✎</button>
          <button class="sn-icon sn-icon-danger" title="Delete note" data-action="delete" data-id="${esc(c.id)}">🗑</button>
        </span>
      </div>`;
    const palette = colorPickerId === c.id ? paletteHtml(c) : "";

    return `<article class="${classes.join(" ")}" data-id="${esc(c.id)}">
        ${head}
        ${bodyBlock}
        ${repliesBlock}
        ${replyBtn}
        ${tools}
        ${palette}
      </article>`;
  }

  function panelHtml(side, orphaned) {
    const list = commentsForSide(side);
    const cards = list.length
      ? list.map((c) => cardHtml(c, orphaned.has(c.id))).join("")
      : `<p class="sn-empty">No notes on this side yet. Select text on the page, then choose <strong>Add note</strong>.</p>`;
    return `<aside class="sn-panel sn-panel-${side}">
        <header class="sn-head">
          <div class="sn-brand"><span class="sn-brand-mark">▎</span> SideNote</div>
          <div class="sn-head-tools">
            <span class="sn-count">${list.filter((c) => !c.resolved).length}</span>
            <button class="sn-icon" title="Close panel" data-action="close" data-side="${side}">✕</button>
          </div>
        </header>
        <div class="sn-cards">${cards}</div>
        <footer class="sn-foot">
          <button class="sn-link" data-action="all-notes">All notes</button>
          <button class="sn-link" data-action="settings">Settings</button>
        </footer>
      </aside>`;
  }

  function fabHtml(side, count) {
    return `<button class="sn-fab sn-fab-${side}" data-action="open" data-side="${side}" title="Open SideNote (${count} note${count === 1 ? "" : "s"})">
        <span class="sn-fab-mark">💬</span>${count ? `<span class="sn-fab-count">${count}</span>` : ""}
      </button>`;
  }

  function render() {
    if (!shadow) return;
    hostEl.dataset.theme = currentTheme();
    const orphaned = renderAnnotations();
    const chromeEl = shadow.getElementById("sn-chrome");
    let html = "";
    sidesInUse().forEach((side) => {
      if (open[side]) {
        html += panelHtml(side, orphaned);
      } else {
        const count = commentsForSide(side).filter((c) => !c.resolved).length;
        html += fabHtml(side, count);
      }
    });
    chromeEl.innerHTML = html;
    applyPush();

    if (editingId) {
      const ta = shadow.querySelector(`.sn-textarea[data-id="${cssEscape(editingId)}"]`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
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

  function deleteComment(id) {
    if (draft && draft.id === id) {
      draft = null;
      editingId = null;
      render();
      return;
    }
    comments = comments.filter((c) => c.id !== id);
    if (editingId === id) editingId = null;
    mutatePage((e) => {
      e.comments = (e.comments || []).filter((c) => c.id !== id);
    });
  }

  /* ----------------------------------------------- Selection → add */
  let pendingRect = null;

  function onSelectionChange() {
    if (!active || !settings.addSelectionButton) return;
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
    window.getSelection().removeAllRanges();
    createNote(anchor);
  }

  // Build an element anchor from a right-clicked element (no highlight; a pin).
  function anchorFromElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
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

  // The single note-creation pipeline. Every trigger (the selection button, the
  // context menu, the keyboard command, and the drawing tools in a later phase)
  // funnels through here: it opens a draft card in edit mode on the right side.
  function createNote(anchor, opts) {
    if (!active) return;
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

  function applyState() {
    const wasActive = active;
    active = isPageEnabled(entry, settings);

    if (active && !wasActive) {
      buildHost();
      autoOpenSidesWithNotes();
    }
    if (!active && wasActive) {
      unwrapAll();
      clearOverlay();
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
  // Keep pins/drawings aligned with their elements as the page scrolls/resizes.
  window.addEventListener("scroll", scheduleOverlayRedraw, { passive: true });
  window.addEventListener("resize", scheduleOverlayRedraw, { passive: true });

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
    }
  });

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

    .sn-panel {
      position: fixed; top: 0; bottom: 0; width: 320px;
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
      box-shadow: var(--shadow); cursor: pointer; padding: 8px 10px; font-size: 14px;
    }
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
