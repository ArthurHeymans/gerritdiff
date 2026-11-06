# GerritDiff

A fast, focused diff viewer for public Gerrit changes, inspired by [DiffsHub](https://diffshub.com/).

## Features

- Save a Gerrit server and public username for a personal, read-only review dashboard
- Triage anonymously visible changes across projects as needs action, unclear, waiting, or ready
- Filter dashboard work by owned changes, incoming reviews, project, topic, and configurable recent/inactive activity age
- See explicit warnings when identity, attention, or dashboard queries are unavailable anonymously
- Queue owned changes for abandonment, add a message per change, and copy one combined SSH command
- Paste modern (`/c/project/+/123`) or legacy (`/#/c/123`) Gerrit change URLs
- Server-side Gerrit proxy, so the browser does not depend on Gerrit CORS settings
- Change metadata, patchset, branch, author, and file statistics
- Compare any patchset against its parent or any other patchset
- Virtualized, syntax-highlighted diffs powered by `@pierre/diffs` CodeView
- Repository navigation powered by `@pierre/trees` FileTree
- Lazy Gitiles tree browsing for files outside the change
- Full-file expansion using current and parent patchset contents
- Unified and side-by-side diff layouts
- Existing Gerrit discussions grouped by current and historical patchsets
- Line and range comments using Pierre annotations and gutter utilities
- Explicit review export with a copyable `gerrit review --json` SSH command; nothing is published until you run it
- Tab-scoped recovery of saved drafts and unfinished comment/reply editors, isolated by patchset comparison
- Mobile file/discussion navigation and keyboard-accessible modal actions
- Dark and light Pierre themes
- Basic SSRF protection for the public proxy

## Development

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

### Tests

```bash
npm test
npm run lint
npx playwright install chromium
npm run test:browser
```

Browser tests start a local server on port 3210 and use mocked Gerrit responses;
they never publish reviews. They cover light/dark themes, narrow layouts, keyboard
focus, draft recovery, navigation guards, and clipboard failure. Set `CHROMIUM_PATH`
to use an existing browser executable. Screenshots and traces are written to
`test-results/` (ignored by Git). If the app is already running locally, use
`PLAYWRIGHT_PORT=3000 npm run test:browser` to reuse it rather than starting a
second Next.js development server.

The change overview and diff share one scrolling surface on desktop and mobile.
As the overview scrolls away, a compact title, patchset, Export action, and review
toolbar stay at the top. Scroll back up or click the compact title to return to
the full details. The desktop file browser scrolls independently.

Installation applies a small, guarded Pierre 1.2.12 virtualization padding fix in
`scripts/patch-pierre-diffs.mjs`; re-evaluate it when upgrading the dependency.

Saved review drafts live in this browser tab's session storage, not on Gerrit.
Unfinished editor text is recovered after reloads and Back/Forward navigation;
editor switching and patchset/link navigation also warn before replacing active
writing. Save each comment or reply to include it in an export. After running
an exported review, verify it in Gerrit, then clear the saved drafts if desired.

## Production

```bash
npm run build
npm run start
```

GerritDiff currently supports anonymously readable changes. Dashboard profiles
store only a Gerrit server URL and username in local browser storage; they do not
authenticate to Gerrit or grant access to private changes. Full repository tree
browsing requires the Gerrit project to advertise a Gitiles web link; known file
paths can still be opened directly through Gerrit's commit content API.

## License

Licensed under either of the following, at your option:

- [Apache License, Version 2.0](LICENSE-APACHE)
- [MIT License](LICENSE-MIT)
