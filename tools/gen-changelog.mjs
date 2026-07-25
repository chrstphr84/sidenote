#!/usr/bin/env node
// Generates CHANGELOG.md from changelog.json (the single source of truth).
// Run from the repo root:  node tools/gen-changelog.mjs
//
// changelog.json is also read directly by the in-extension changelog page,
// so this keeps the human-readable markdown in sync without duplicating data.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releases = JSON.parse(readFileSync(join(root, "changelog.json"), "utf8"));

const header = `# Changelog

<!-- Generated from changelog.json by tools/gen-changelog.mjs. Do not edit by hand. -->

All notable changes to SideNote are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project aims to follow [Semantic Versioning](https://semver.org/): a **minor**
bump for a feature (or batch of features), a **patch** bump for tweaks and fixes.
`;

const body = releases
  .map((rel) => {
    const sections = (rel.sections || [])
      .map((s) => {
        const items = (s.items || []).map((i) => `- ${i}`).join("\n");
        return `### ${s.label}\n${items}`;
      })
      .join("\n\n");
    return `## [${rel.version}]\n\n${sections}`;
  })
  .join("\n\n");

const links = releases
  .map((rel) => `[${rel.version}]: #${rel.version.replace(/\./g, "")}`)
  .join("\n");

writeFileSync(join(root, "CHANGELOG.md"), `${header}\n${body}\n\n${links}\n`);
console.log(`Wrote CHANGELOG.md (${releases.length} releases).`);
