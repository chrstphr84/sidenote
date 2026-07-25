# Changelog

<!-- Generated from changelog.json by tools/gen-changelog.mjs. Do not edit by hand. -->

All notable changes to SideNote are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project aims to follow [Semantic Versioning](https://semver.org/): a **minor**
bump for a feature (or batch of features), a **patch** bump for tweaks and fixes.

## [0.2.1]

### Changed
- Single-page-app navigation is now detected with the Navigation API (event-driven) instead of polling, with a popstate + poll fallback on older Chrome.

## [0.2.0]

### Added
- Threaded replies: reply to a note, and edit or delete individual replies. Reply counts show on the All-notes page.
- Per-note highlight color: pick from a palette on each note; the on-page highlight updates to match.
- Single-page-app support: when a site changes the page without a full reload, SideNote re-keys to the new page's notes automatically.

## [0.1.0]

### Added
- Proof of concept: attach comments to highlighted text on any web page, shown in a margin like Google Docs.
- Per-page on/off from the toolbar popup, plus a master switch across all pages.
- Margin can sit on the left, right, or both sides; set the default in Settings or per page from the popup.
- Open and close the margin from a tab on the page edge without losing any notes.
- Notes persist in local storage keyed by page, so they return after closing the tab or window.
- Highlights re-anchor to their text on reload using the surrounding context, and notes whose text is gone are flagged rather than lost.
- On-page indication: highlighted text plus a toolbar badge counting open notes.
- Per-note actions: edit, resolve, move to the other side, and delete.
- All-notes page (opens in its own tab) listing every commented page, with remove single, remove selected, and clear all.
- Settings page (opens in its own tab) with Light / Dark / Auto theme, default margin side, highlight color, and margin width, styled to match Colorbars.
- In-extension Help and Changelog pages.

[0.2.1]: #021
[0.2.0]: #020
[0.1.0]: #010
