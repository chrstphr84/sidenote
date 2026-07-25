// Pure transforms from the pages object → export strings, in several formats.
// No DOM or chrome APIs here so it stays easy to test; pages.js handles the
// download / print orchestration.

function exportDate(ts) {
  const n = Number(ts);
  if (!n) return "";
  try {
    return new Date(n).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  } catch (_) {
    return "";
  }
}

function exportHostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return url || "";
  }
}

// A short, human label for a note's anchor.
function exportAnchorLabel(anchor) {
  if (!anchor) return "Note";
  if (anchor.type === "element") {
    const t = anchor.target || {};
    return `Element: ${t.attrHint || t.textHint || t.tag || "element"}`;
  }
  if (anchor.type === "region") {
    const kinds = (anchor.shapes || []).map((s) => s.kind);
    const t = anchor.target || {};
    return `Drawing (${kinds.join(", ") || "shapes"})${t.tag ? ` on <${t.tag}>` : ""}`;
  }
  const q = String(anchor.exact || "");
  return `Note on “${q.length > 60 ? q.slice(0, 60) + "…" : q}”`;
}

function exportSortedKeys(pages) {
  return Object.keys(pages).sort((a, b) => (pages[b].updatedAt || 0) - (pages[a].updatedAt || 0));
}

function exportCounts(pages) {
  const keys = exportSortedKeys(pages);
  const notes = keys.reduce((n, k) => n + (pages[k].comments || []).length, 0);
  return { pages: keys.length, notes };
}

/* ------------------------------------------------------------ Markdown */
function toMarkdown(pages) {
  const keys = exportSortedKeys(pages);
  const c = exportCounts(pages);
  const out = ["# SideNote export", "", `_Generated ${exportDate(Date.now())} · ${c.pages} page(s) · ${c.notes} note(s)_`, ""];
  keys.forEach((key) => {
    const p = pages[key];
    out.push(`## ${p.title || exportHostFromUrl(p.url)}`);
    out.push(`<${p.url}>`);
    out.push(`_${(p.comments || []).length} note(s) · updated ${exportDate(p.updatedAt)}_`, "");
    (p.comments || []).forEach((note) => {
      out.push(`### ${exportAnchorLabel(note.anchor)}${note.resolved ? " _(resolved)_" : ""}`);
      if (note.anchor && note.anchor.type === "text" && note.anchor.exact) {
        out.push(`> ${note.anchor.exact.replace(/\n/g, " ")}`, "");
      }
      out.push(note.body ? note.body : "_(no note text)_");
      (note.replies || []).forEach((r) => out.push(`- _reply_: ${r.body}`));
      out.push("");
    });
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/* ----------------------------------------------------------- Plaintext */
function toPlaintext(pages) {
  const keys = exportSortedKeys(pages);
  const c = exportCounts(pages);
  const out = ["SideNote export", `Generated ${exportDate(Date.now())} — ${c.pages} page(s), ${c.notes} note(s)`, ""];
  keys.forEach((key) => {
    const p = pages[key];
    out.push("========================================");
    out.push(p.title || exportHostFromUrl(p.url));
    out.push(p.url);
    out.push(`${(p.comments || []).length} note(s) — updated ${exportDate(p.updatedAt)}`, "");
    (p.comments || []).forEach((note) => {
      out.push(`• ${exportAnchorLabel(note.anchor)}${note.resolved ? " (resolved)" : ""}`);
      if (note.anchor && note.anchor.type === "text" && note.anchor.exact) {
        out.push(`  "${note.anchor.exact.replace(/\n/g, " ")}"`);
      }
      out.push(`  ${note.body || "(no note text)"}`);
      (note.replies || []).forEach((r) => out.push(`    ↳ reply: ${r.body}`));
      out.push("");
    });
  });
  return out.join("\n").trim() + "\n";
}

/* ---------------------------------------------------------------- CSV */
function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(pages) {
  const rows = [
    ["Page title", "Page URL", "Type", "Anchor", "Note", "Resolved", "Side", "Created", "Updated", "Replies"]
  ];
  exportSortedKeys(pages).forEach((key) => {
    const p = pages[key];
    (p.comments || []).forEach((note) => {
      rows.push([
        p.title || "",
        p.url || "",
        (note.anchor && note.anchor.type) || "text",
        exportAnchorLabel(note.anchor),
        note.body || "",
        note.resolved ? "yes" : "no",
        note.side || "",
        exportDate(note.createdAt),
        exportDate(note.updatedAt),
        (note.replies || []).map((r) => r.body).join(" | ")
      ]);
    });
  });
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

/* -------------------------------------------------- HTML (for PDF/print) */
function htmlEscape(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

function toExportHtml(pages) {
  const keys = exportSortedKeys(pages);
  const c = exportCounts(pages);
  const sections = keys
    .map((key) => {
      const p = pages[key];
      const notes = (p.comments || [])
        .map((note) => {
          const quote =
            note.anchor && note.anchor.type === "text" && note.anchor.exact
              ? `<blockquote>${htmlEscape(note.anchor.exact)}</blockquote>`
              : "";
          const replies = (note.replies || [])
            .map((r) => `<li>${htmlEscape(r.body)}</li>`)
            .join("");
          return `<div class="note${note.resolved ? " resolved" : ""}">
            <div class="anchor">${htmlEscape(exportAnchorLabel(note.anchor))}${note.resolved ? " (resolved)" : ""}</div>
            ${quote}
            <div class="body">${note.body ? htmlEscape(note.body) : "<em>(no note text)</em>"}</div>
            ${replies ? `<ul class="replies">${replies}</ul>` : ""}
          </div>`;
        })
        .join("");
      return `<section class="page">
          <h2>${htmlEscape(p.title || exportHostFromUrl(p.url))}</h2>
          <div class="url">${htmlEscape(p.url)}</div>
          <div class="meta">${(p.comments || []).length} note(s) · updated ${htmlEscape(exportDate(p.updatedAt))}</div>
          ${notes}
        </section>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>SideNote export</title>
    <style>
      body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #202124; margin: 32px; }
      h1 { font-size: 22px; margin: 0 0 4px; }
      .gen { color: #5f6368; margin-bottom: 20px; }
      .page { page-break-inside: auto; margin: 0 0 28px; padding-bottom: 8px; border-bottom: 1px solid #dadce0; }
      h2 { font-size: 17px; margin: 18px 0 2px; }
      .url { color: #1a73e8; font-size: 12px; word-break: break-all; }
      .meta { color: #80868b; font-size: 12px; margin: 2px 0 12px; }
      .note { border-left: 3px solid #1a73e8; padding: 2px 0 2px 12px; margin: 0 0 12px; page-break-inside: avoid; }
      .note.resolved { border-left-color: #9aa0a6; color: #5f6368; }
      .anchor { font-weight: 600; font-size: 13px; }
      blockquote { margin: 4px 0; color: #5f6368; font-style: italic; }
      .body { white-space: pre-wrap; }
      .replies { margin: 6px 0 0; padding-left: 18px; color: #5f6368; }
      @media print { body { margin: 0.5in; } a { color: inherit; } }
    </style></head><body>
    <h1>SideNote export</h1>
    <div class="gen">Generated ${htmlEscape(exportDate(Date.now()))} · ${c.pages} page(s) · ${c.notes} note(s)</div>
    ${sections}
  </body></html>`;
}
