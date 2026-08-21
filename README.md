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
- Copyable `gerrit review --json` SSH command for publishing comments, replies, a review message, and a Code-Review vote
- Dark and light Pierre themes
- Basic SSRF protection for the public proxy

## Development

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

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
