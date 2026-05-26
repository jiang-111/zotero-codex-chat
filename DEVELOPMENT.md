# Development Notes

## Package

Run from the repository root:

```bash
zip -r ../zotero-codex-chat-zotero904-v0213-mcp-confirm.xpi .
```

Do not include generated `.xpi` files in git.

## Runtime Shape

- `bootstrap.js` registers the plugin chrome path and loads `content/scripts/zotero-codex-chat.js`.
- `content/scripts/zotero-codex-chat.js` runs in Zotero chrome context. It owns Zotero APIs, Reader hooks, note writing, sidebar injection, Codex process startup, and the WebSocket bridge process.
- `content/chat.xhtml`, `content/chat.css`, and `content/scripts/chat-window.js` implement the embedded chat UI.
- `prefs.js` defines default plugin preferences.
- `scripts/setup-codex-zotero-mcp.sh` writes the Codex MCP config snippet.

## Important Safety Decisions

- Reader selected-text Ask Codex stages text in the chat input and does not auto-send.
- Reader prompts explicitly say not to call Zotero MCP.
- Zotero MCP read and write calls both require confirmation. Read calls can freeze Zotero because the MCP server runs inside Zotero.
- Child note writing avoids Zotero 9 `key is not valid` failures by saving a note first, then attaching it via `itemNotes.parentItemID`, reloading caches, and notifying Zotero.
