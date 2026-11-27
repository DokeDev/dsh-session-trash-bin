# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-27

Modified fork of TuWeiZhi/dsh-session-delete that turns the one-way trash move into a
trash bin. Still zero dependencies and no build step.

### Added

- **Session trash…** menu item with a modal trash manager.
- **Restore** a trashed session: moves its directory back to the original project
  directory and reattaches the workspace, archived and pinned state recorded at deletion
  time.
- **Delete permanently** one trash entry, and **Empty trash** for the whole folder, both
  with an inline second confirmation.
- A `.json` sidecar beside every trashed directory holds the restore metadata; legacy
  entries without one are listed but can only be permanently deleted.
- Tests for trash listing, restore, per-entry purge, empty-trash, legacy entries, and
  traversal-shaped names.

### Changed

- Package renamed to `dsh-session-trash-bin`; route is now
  `/dsh-session-trash-bin`.
- Deletion dialog copy explains that the session is recoverable, and the success toast
  offers **Restore**.

## [0.1.0] — 2026-11-11

First public release. Distilled from a local profile plugin that had been running
against DSH `0.2.2-rc.1`.

### Added

- **Delete session** action on the sidebar context menu, with a confirmation dialog.
- Real deletion of **live** sessions: the agent is cancelled and awaited, the session is
  detached from the in-process session and agent registries (which lets the persistence
  layer flush, release its write lease and close its file handle), then the directory is
  moved to `<DSH_HOME>/sessions-trash/<timestamp>__<session-id>`.
- Reactive list update through the official `api-session/removed` event — no page reload.
- Main view falls back to the empty state when the deleted session was the focused one.
- Retrying directory move for Windows handle contention (`EPERM`/`EBUSY`/`EACCES`/`ENOTEMPTY`),
  with the concrete error code surfaced when retries are exhausted.
- `GET /dsh-session-delete/diag` reporting the loaded revision, live session/agent ids and
  which internal hooks the running DSH build exposes.
- `npm run check`: manifest/bundle/icon/locale self-check plus host-simulation tests for the
  delete sequence (live and idle sessions, single removal event, trash landing, error paths).

### Notes

- The host half registers an HTTP route in-process, so installing or replacing the plugin
  requires a DSH restart (or a plugin disable/enable toggle) to take effect.
- Removal is not shredded: the directory is moved, so a session can be restored by hand.
