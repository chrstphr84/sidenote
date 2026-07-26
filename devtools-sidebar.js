// SideNote DevTools sidebar. On click it marks the currently-inspected element
// ($0) with a data attribute (via inspectedWindow.eval, which runs in the page),
// then asks the background worker to tell the content script to link it.

const btn = document.getElementById("link-btn");
const statusEl = document.getElementById("status");

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

// Runs in the inspected page: tag $0 so the content script can find it. Returns
// a small descriptor so we can show what was linked.
const MARK_EXPR = `(function () {
  var el = (typeof $0 !== 'undefined') ? $0 : null;
  if (!el || el.nodeType !== 1) return null;
  document.querySelectorAll('[data-sidenote-pick]').forEach(function (n) { n.removeAttribute('data-sidenote-pick'); });
  el.setAttribute('data-sidenote-pick', '1');
  var label = el.getAttribute('aria-label') || el.getAttribute('name') || (el.textContent || '').trim().slice(0, 40);
  return { tag: el.tagName.toLowerCase(), label: label };
})()`;

btn.addEventListener("click", () => {
  setStatus("");
  chrome.devtools.inspectedWindow.eval(MARK_EXPR, (result, exception) => {
    if (exception) {
      setStatus("Couldn't read the selected element.", "err");
      return;
    }
    if (!result) {
      setStatus("Select an element in the Elements tree first.", "err");
      return;
    }
    chrome.runtime.sendMessage({
      type: "sn-devtools-link",
      tabId: chrome.devtools.inspectedWindow.tabId
    });
    const name = result.label ? `${result.tag} · ${result.label}` : `<${result.tag}>`;
    setStatus(`Linked ${name}`, "ok");
  });
});
