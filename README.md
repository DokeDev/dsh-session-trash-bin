# Session trash bin

[English](README.md) | [简体中文](README.zh.md)

[![CI](https://github.com/DokeDev/dsh-session-trash-bin/actions/workflows/ci.yml/badge.svg)](https://github.com/DokeDev/dsh-session-trash-bin/actions/workflows/ci.yml)

[github.com/DokeDev/dsh-session-trash-bin](https://github.com/DokeDev/dsh-session-trash-bin)

A trash bin for DeepSeek Harness conversations. Deleting a session no longer shreds it:
the session moves into a trash folder beside the sessions root, leaves the sidebar at once,
and can be restored, permanently deleted, or emptied from a small in-app dialog.

This is a modified fork of [TuWeiZhi/dsh-session-delete](https://github.com/TuWeiZhi/dsh-session-delete)
(MIT). The original only moved sessions into `sessions-trash`; this fork adds a trash
manager with Restore and Delete permanently. It keeps the original **zero-dependency**,
**no-build** design: only `node:fs`, `node:path`, and `node:os`.

## Install

1. Clone this repository, or download it as a ZIP:

   ```sh
   git clone https://github.com/DokeDev/dsh-session-trash-bin.git
   ```

2. Open **Plugins** in the left sidebar.
3. Choose **Add plugin** and enter the absolute path of the cloned
   `dsh-session-trash-bin` directory.
4. If the Host asks whether to enable it, choose **Enable now**. The Host half is imported
   once at startup, so a plugin toggle or a DSH restart may be required; the browser half
   loads with the next page refresh.
5. Confirm the **Session trash bin** row appears and is enabled.

The package is not published; install it from the local directory.

If the original `@tuweizhi/dsh-session-delete` is installed, disable it first: both
plugins would otherwise add a delete action and share the same `sessions-trash` folder.

## Use

### Delete a session

Session row → **“…”** (or right-click) → **Delete session**. Confirm **Move to trash**.

- The row disappears immediately; no page reload.
- If the deleted session is the one on screen, the main view returns to its empty state.
- A success toast offers **Restore** for that session.
- Running work (a turn, a subagent, a background job, or an automation task) is stopped and
  detached first; the session is only moved after that shutdown sequence.

### Session trash

Session row → **“…”** → **Session trash…** opens the trash bin:

- every trashed session, with title, deletion time, size, and id;
- **Restore**: moves the directory back to its original project directory and reattaches
  the session to its workspace, including its archived or pinned state when possible;
- **Delete permanently**: erases that one trash entry (click twice to confirm);
- **Empty trash**: erases every trash entry after a second confirmation;
- **Refresh**: reloads the list.

Restored sessions are cold sessions; the app's session list refreshes after the operation.

## What is deleted, and what is kept

A normal delete moves the whole session directory — every `.jsonl.zstd` generation and
`session.lock` — into:

```text
<DSH_HOME>/sessions-trash/<timestamp>-<random>__<sessionId>/
<DSH_HOME>/sessions-trash/<timestamp>-<random>__<sessionId>.json
```

The `.json` sidecar stores the original project directory, title, deletion time, size, and
workspace/archive/pin state needed for Restore.

A permanent delete removes both the directory and its sidecar. **Empty trash** removes the
whole `sessions-trash` folder.

Not deleted:

- **Subagent sessions**: they are separate sessions with their own identity; this plugin
  does not cascade into them. They remain on disk (hidden from the sidebar) when their
  parent is deleted.
- **Attachments**: content-addressed files may be shared by several conversations.
- **Files the conversation created in your project**: the plugin only touches Harness
  session state under the sessions root and `sessions-trash`.

## Recycle-bin details

- The trash is a plain folder, not the macOS Trash and not a DSH feature.
- Entries are independent; deleting one does not affect the others.
- A legacy entry created by the original plugin has no sidecar. It is listed as
  **legacy**, can be permanently deleted, but cannot be restored automatically; move its
  directory back into the sessions root by hand.
- There is no automatic retention or age-based cleanup. Empty the trash when you want the
  space back.
- Paths are always derived from a validated session id or a validated trash entry name,
  never from a client-supplied filesystem path. Destructive POSTs require a loopback peer
  and a same-origin `Origin`.

## Requirements and limitations

- DSH `>= 0.2.1-alpha.1` (tested on the 0.2.2 line; the original was verified against
  0.2.2-rc.1), Node.js `>= 22.19.0`.
- The Host half uses DSH's internal `sessions`, `agents`, `workspaceRegistry`,
  `sessionPersistence`, and `webServer` services. Each call is feature-detected, but a DSH
  release that renames those internals can degrade the plugin.
- The Host registers an HTTP route under `/dsh-session-trash-bin`; it is loopback-only.
- The dialog is plain DOM appended to `document.body`, so it stays above the sidebar
  drawer; it follows the page's light/dark background for its own palette.
- Only Chinese and English strings are built in; other DSH languages fall back to English.
- Turning the plugin off removes the menu items and the route. Sessions already moved to
  `sessions-trash` stay there; nothing is restored automatically.

## Uninstall

Remove the bundle from **Plugins**. The `sessions-trash` folder is left untouched; remove it
by hand if you no longer want the deleted sessions.

## License

MIT. Based on TuWeiZhi/dsh-session-delete; see `LICENSE`.
