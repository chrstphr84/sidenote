// DevTools entry point: adds a "SideNote" pane to the Elements panel sidebar so
// the element selected in the Elements tree ($0) can be linked precisely — handy
// for tiny or custom controls (checkboxes, icons) that are hard to right-click.

chrome.devtools.panels.elements.createSidebarPane("SideNote", (pane) => {
  pane.setPage("devtools-sidebar.html");
});
