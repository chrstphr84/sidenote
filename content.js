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
  const PAGE_KEY = pageKeyFromHref(location.href);

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
  let editingId = null; // id of the comment currently being edited
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
      if (found === -1) return { exact, prefix: "", suffix: "", index: 0 };
      startG = found;
      endG = found + exact.length;
    }

    return {
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

  function spansFor(id) {
    return Array.from(document.querySelectorAll(`.__sidenote_hl[data-sidenote-id="${cssEscape(id)}"]`));
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

  // Re-anchor and re-wrap every comment (and the draft). Returns the ids that
  // could not be located so the UI can flag them.
  function applyHighlights() {
    unwrapAll();
    const orphaned = new Set();
    renderList().forEach((c) => {
      const range = findRange(c.anchor);
      if (!range) {
        orphaned.add(c.id);
        return;
      }
      const spans = highlightRange(range, c);
      if (spans.length === 0) orphaned.add(c.id);
    });
    return orphaned;
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
      <div id="sn-chrome"></div>
      <button id="sn-add" class="sn-add" type="button" hidden>💬 Add note</button>
      <div id="sn-toast" class="sn-toast" hidden></div>`;
    (document.documentElement || document.body).appendChild(hostEl);

    shadow.getElementById("sn-add").addEventListener("mousedown", (e) => e.preventDefault());
    shadow.getElementById("sn-add").addEventListener("click", onAddClick);
    shadow.getElementById("sn-chrome").addEventListener("click", onChromeClick);
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

  function cardHtml(c, orphaned) {
    const editing = c.id === editingId;
    const quote = esc(c.anchor.exact.length > 140 ? c.anchor.exact.slice(0, 140) + "…" : c.anchor.exact);
    const classes = ["sn-card"];
    if (c.resolved) classes.push("sn-card-resolved");
    if (orphaned) classes.push("sn-card-orphan");
    if (editing) classes.push("sn-card-editing");

    const bodyBlock = editing
      ? `<textarea class="sn-textarea" data-id="${esc(c.id)}" placeholder="Add your note…" rows="3">${esc(c.body || "")}</textarea>
         <div class="sn-card-actions">
           <button class="sn-btn sn-btn-primary" data-action="save" data-id="${esc(c.id)}">Save</button>
           <button class="sn-btn" data-action="cancel" data-id="${esc(c.id)}">Cancel</button>
         </div>`
      : `<div class="sn-body">${c.body ? esc(c.body) : '<span class="sn-body-empty">No note text</span>'}</div>
         <div class="sn-card-meta">
           <span>${esc(formatTime(c.updatedAt || c.createdAt))}${orphaned ? " · not found on page" : ""}</span>
           <span class="sn-card-tools">
             <button class="sn-icon" title="${c.resolved ? "Reopen" : "Resolve"}" data-action="resolve" data-id="${esc(c.id)}">${c.resolved ? "↩" : "✓"}</button>
             <button class="sn-icon" title="Move to other side" data-action="flip" data-id="${esc(c.id)}">⇄</button>
             <button class="sn-icon" title="Edit" data-action="edit" data-id="${esc(c.id)}">✎</button>
             <button class="sn-icon sn-icon-danger" title="Delete" data-action="delete" data-id="${esc(c.id)}">🗑</button>
           </span>
         </div>`;

    return `<article class="${classes.join(" ")}" data-id="${esc(c.id)}">
        <blockquote class="sn-quote" data-action="goto" data-id="${esc(c.id)}">${quote}</blockquote>
        ${bodyBlock}
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
    const orphaned = applyHighlights();
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
        if (id === editingId || (draft && draft.id === editingId)) cancelEdit();
        render();
        break;
      case "goto":
        gotoHighlight(id);
        break;
      case "edit":
        editingId = id;
        render();
        break;
      case "cancel":
        cancelEdit();
        render();
        break;
      case "save":
        saveEdit(id);
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

  function gotoHighlight(id) {
    const spans = spansFor(id);
    if (spans.length === 0) {
      showToast("This note's text wasn't found on the page.");
      return;
    }
    spans[0].scrollIntoView({ behavior: "smooth", block: "center" });
    spans.forEach((s) => {
      s.classList.add("__sidenote_hl_flash");
      setTimeout(() => s.classList.remove("__sidenote_hl_flash"), 1000);
    });
  }

  function saveEdit(id) {
    const ta = shadow.querySelector(`.sn-textarea[data-id="${cssEscape(id)}"]`);
    const body = ta ? ta.value.trim() : "";

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

  function cancelEdit() {
    if (draft && draft.id === editingId) draft = null;
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
    if (!active) return;
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
    const inUse = sidesInUse();
    const side = inUse.includes(settings.defaultSides) ? settings.defaultSides : inUse.includes("right") ? "right" : inUse[0];
    draft = {
      id: genId("note"),
      anchor,
      body: "",
      side,
      color: settings.highlightColor,
      resolved: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    editingId = draft.id;
    open[panelSideFor(draft)] = true;
    hideAddButton();
    window.getSelection().removeAllRanges();
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
  function applyState() {
    const wasActive = active;
    active = isPageEnabled(entry, settings);

    if (active && !wasActive) {
      buildHost();
      // Auto-open a side when it already has notes.
      sidesInUse().forEach((side) => {
        if (commentsForSide(side).some((c) => !c.resolved)) open[side] = true;
      });
    }
    if (!active && wasActive) {
      unwrapAll();
      const html = document.documentElement;
      if (html) {
        html.style.removeProperty("margin-left");
        html.style.removeProperty("margin-right");
      }
      removeHost();
      return;
    }
    if (active) render();
  }

  async function reload() {
    settings = await getSettings();
    const pages = await getPages();
    entry = pages[PAGE_KEY] || null;
    comments = entry ? entry.comments.slice() : [];
    // Drop a stale editing id.
    if (editingId && !(draft && draft.id === editingId) && !comments.some((c) => c.id === editingId)) {
      editingId = null;
    }
    applyState();
  }

  /* --------------------------------------------------------- Wiring */
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("click", (e) => {
    // Click on a highlight → jump to its card.
    const hl = e.target.closest && e.target.closest(".__sidenote_hl");
    if (hl && active) {
      const id = hl.getAttribute("data-sidenote-id");
      const side = panelSideFor(renderList().find((c) => c.id === id) || { side: "right" });
      open[side] = true;
      render();
      const card = shadow.querySelector(`.sn-card[data-id="${cssEscape(id)}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("sn-card-flash");
        setTimeout(() => card.classList.remove("sn-card-flash"), 1000);
      }
    }
  });
  window.addEventListener("scroll", hideAddButton, { passive: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "sync" && changes[SETTINGS_KEY]) || (area === "local" && changes[PAGES_KEY])) {
      reload();
    }
  });

  prefersDark.addEventListener("change", () => {
    if (active && settings.theme === "auto") render();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "sn-open") {
      if (!active) return;
      sidesInUse().forEach((side) => (open[side] = true));
      render();
    }
  });

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
    .sn-card-resolved { opacity: 0.7; }
    .sn-card-orphan { border-style: dashed; }
    .sn-card-flash { animation: sn-card-flash 1s ease; }
    @keyframes sn-card-flash {
      0%,100% { box-shadow: 0 0 0 0 rgba(26,115,232,0); }
      30% { box-shadow: 0 0 0 2px var(--accent); }
    }

    .sn-quote {
      margin: 0 0 8px; padding: 4px 0 4px 10px; border-left: 3px solid var(--accent);
      color: var(--text-secondary); font-style: italic; font-size: 12px; cursor: pointer;
      max-height: 4.5em; overflow: hidden;
    }
    .sn-quote:hover { color: var(--text); }
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
