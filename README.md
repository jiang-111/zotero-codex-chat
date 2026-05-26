# Zotero Codex Chat

A minimal Zotero plugin that opens a Codex chat UI inside Zotero and reuses the existing `zotero-mcp-plugin` server.

## What this MVP does

- Adds `Tools -> Open Codex Chat` in Zotero.
- Opens a Zotero-native chat window.
- Checks the existing Zotero MCP server status at `http://127.0.0.1:23120/mcp/status`.
- Starts Codex with `codex app-server --listen ws://127.0.0.1:45123`.
- Connects to Codex app-server over WebSocket.
- Sends Zotero context according to the selected context mode: auto, selected items, current collection, PDF Reader selection, library-wide search, or no context.
- Shows streamed Codex text while hiding raw protocol/status/token usage events.
- Provides a copyable `~/.codex/config.toml` block for the Zotero MCP server.
- Provides one-click note writing with an editable confirmation dialog.

## Required dependency

Install and enable the existing `zotero-mcp-plugin@autoagent.my.xpi` first. This plugin depends on its MCP endpoint.

## Codex MCP config

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.zotero]
url = "http://127.0.0.1:23120/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 120
# Zotero Codex Chat asks before both read and write MCP calls,
# because Zotero MCP execution runs inside Zotero and can freeze the UI.
default_tools_approval_mode = "prompt"

# Emergency read-only mode, if needed:
# disabled_tools = ["write_note", "write_tag", "write_metadata", "write_item"]
```

Or run:

```bash
./scripts/setup-codex-zotero-mcp.sh 23120 zotero
```

## Codex path

The default path is:

```bash
/home/jiangyi/.local/bin/codex-zotero
```

This is intentional: GUI-launched Zotero often has a reduced `PATH`, so a wrapper script that exports the NVM Node path is safer than relying on `which codex`.

A typical wrapper is:

```bash
#!/usr/bin/env bash
export PATH="/home/jiangyi/.nvm/versions/node/v22.22.3/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec /home/jiangyi/.nvm/versions/node/v22.22.3/bin/codex "$@"
```

Make it executable:

```bash
chmod +x /home/jiangyi/.local/bin/codex-zotero
```

## Install

Package as XPI:

```bash
cd zotero-codex-chat
zip -r ../zotero-codex-chat@local.xpi .
```

Install in Zotero via `Tools -> Plugins`, then drag the XPI into the plugin window.

## Limitations

- This MVP uses Codex `app-server` WebSocket mode, which Codex currently documents as experimental.
- It does not yet implement a full MCP proxy layer for write-operation confirmation.
- It relies on Codex's own MCP config to expose Zotero MCP tools to the model.
- If Codex app-server changes its event schema, `content/scripts/chat-window.js` may need adjustment.


## Zotero 9 compatibility note

This build targets Zotero 9 explicitly. The manifest declares `strict_min_version = 9.0` and `strict_max_version = 9.9.9`. The bootstrap loader also normalizes `rootURI` before loading bundled scripts, avoiding malformed `jar:...//content/...` paths.


## Zotero 9.0.4 compatibility

This build uses `strict_min_version = 6.999` and `strict_max_version = 9.*`, matching Zotero 9-compatible plugins such as zotero-mcp-plugin.


## v0.1.6

Fixes menu registration when the plugin is installed/enabled while Zotero main windows are already open. If the Zotero Tools menu cannot be found, a fallback top-level `Codex` menu is added.


## v0.2.1-v0.2.2 changes

- v0.2.1: Protocol notifications are hidden by default; Zotero MCP tool calls are summarized in a collapsible tool activity panel instead of being printed as raw JSON.
- v0.2.2: Added quick actions for summarizing the selected paper, searching the library, drafting a Chinese reading note, and summarizing annotations. These actions remain read-only and ask Codex not to write to Zotero.


## v0.2.3 changes

- Added a one-click “写入 Zotero Note” action that writes the latest Codex reply as a child note under the currently selected Zotero item.
- Added a confirmation/editor dialog before writing the note.
- Historical note: this version originally auto-approved recognized read-only Zotero MCP calls. Current v0.2.13 behavior asks before read and write MCP calls.


## v0.2.5

- Added PDF Reader selected-text right-click menu: **Ask Codex**.
- The selected PDF text is sent directly to the embedded Codex chat sidebar.
- Keeps v0.2.4.1 fixes: child-note writing uses `parentItemID`, and embedded sidebar chat resolves the addon object from parent/top windows.
- Target build: Zotero 9.0.4 compatibility.

## v0.2.6

- Fixed child-note writing on Zotero 9.0.4 by saving the note first and then attaching it with `itemNotes.parentItemID`, avoiding misleading `key is not valid` failures.
- Fixed PDF Reader right-click **Ask Codex** injection by using Zotero Reader's `event.append({ label, onCommand })` API for view, annotation, and selector context menus.

## v0.2.7

- Locks the note write target from the confirmation dialog and passes it into the actual write call, avoiding target drift after focus changes.
- Uses the item-pane `itemKey` and the last PDF Reader Ask Codex source item as write-target hints before falling back to the main Zotero selection.

## v0.2.8

- Refreshes the saved note and parent item's `childItems` cache after DB re-parenting.
- Sends Zotero item modify notifications and selects the parent item after writing, so the note appears under the current paper instead of looking like a standalone note.

## v0.2.9

- Adds an **Ask Codex** button to Zotero Reader's text-selection popup via `renderTextSelectionPopup`, so selected PDF text can be sent without relying on the more fragile right-click context-menu path.
- Reads selected text from `params.annotation.text` first, then falls back to iframe/window selection sources.

## v0.2.10

- Captures selected PDF text while the Reader selection popup is rendered, before the button click can clear or move focus away from the selection.
- Adds extra extraction fallbacks for wrapped Reader annotation objects and Reader selection-popup state.

## v0.2.11

- Defers PDF Reader **Ask Codex** prompt delivery until after the Reader click event finishes, avoiding UI-thread freezes from opening the sidebar/iframe inside the selection popup handler.
- Defers auto-submit inside the chat frame by one event loop tick so the embedded UI can paint before Codex startup or WebSocket work begins.

## v0.2.12

- Prevents PDF Reader freezes by staging **Ask Codex** prompts in the chat input instead of auto-sending them.
- The Reader selection button now opens/fills the chat, and the user manually clicks Send to start Codex work.

## v0.2.13

- Stops silently auto-approving Zotero MCP read tools. Every MCP read/write call now requires confirmation because Zotero MCP execution can freeze the Zotero UI.
- Reader **Ask Codex** prompts explicitly instruct Codex to use the supplied selected text only and not call Zotero MCP.
