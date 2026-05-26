# Zotero Codex Chat

Zotero Codex Chat is a Zotero 9 plugin that embeds a Codex-powered chat panel inside Zotero. It is designed for paper reading, note drafting, and lightweight literature workflows without leaving the Zotero UI.

## Features

- Embedded Codex chat panel in Zotero.
- Context-aware prompts from the selected Zotero item, collection, or PDF Reader selection.
- PDF Reader selected-text action: select text in a PDF, click **Ask Codex**, and stage the prompt in the chat input.
- Quick actions for summarizing papers, searching related literature, drafting Chinese reading notes, and organizing annotations.
- One-click writing of the latest Codex response into a Zotero child note, with an editable confirmation dialog.
- Zotero MCP status check and copyable Codex MCP config.
- Explicit confirmation before Zotero MCP read/write calls, because MCP execution runs inside Zotero and heavy reads may temporarily freeze the UI.

## Requirements

- Zotero 9.x.
- Codex CLI with `app-server` support.
- Node.js available to Zotero for the local WebSocket bridge.
- Optional but recommended: `zotero-mcp-plugin`, if you want Codex to search/read your Zotero library through MCP tools.

## Install

Package the plugin as an XPI:

```bash
cd zotero-codex-chat
zip -r ../zotero-codex-chat.xpi .
```

Then install it in Zotero:

1. Open `Tools -> Plugins`.
2. Drag the generated `.xpi` file into the plugin window.
3. Restart Zotero.

## Configure Codex

Open the Zotero Codex Chat panel and configure:

- `Codex binary path`
- `Node binary path`
- Codex app-server port
- Bridge port
- Zotero MCP port and server name
- Optional model and working directory

No Codex binary path is hard-coded by default. Configure it after installing the plugin.

## Custom Codex Path

You can use any executable as the Codex binary path.

In the plugin UI, set **Codex binary path** to one of:

```bash
/usr/local/bin/codex
$HOME/.npm-global/bin/codex
$HOME/.nvm/versions/node/vXX/bin/codex
$HOME/.local/bin/codex-zotero
```

For GUI-launched Zotero, a wrapper script is often more reliable than relying on shell `PATH`. Example:

```bash
#!/usr/bin/env bash
CODEX_BIN="${CODEX_BIN:-codex}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec "$CODEX_BIN" "$@"
```

Save it as:

```bash
$HOME/.local/bin/codex-zotero
```

Make it executable:

```bash
chmod +x "$HOME/.local/bin/codex-zotero"
```

Then set **Codex binary path** in the plugin UI to that wrapper path.

You can also set a packaged default in `prefs.js` before building your own XPI:

```js
pref("extensions.zotero.zotero-codex-chat.codex.binaryPath", "/absolute/path/to/codex-zotero");
```

## Zotero MCP Config

If you use `zotero-mcp-plugin`, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.zotero]
url = "http://127.0.0.1:23120/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"
```

Or generate the config snippet with:

```bash
./scripts/setup-codex-zotero-mcp.sh 23120 zotero
```

MCP tool calls are not silently approved by the plugin. Confirm only the calls you actually want to run, especially full-text reads or library-wide searches.

## Usage

Open the Codex Chat panel from Zotero and start Codex. You can:

- Ask about the selected Zotero item.
- Select text in the PDF Reader and click **Ask Codex**.
- Generate a reading note and write it back as a Zotero child note.
- Use MCP tools after confirming the requested Zotero operation.

For PDF Reader selected text, the plugin stages the prompt in the chat input instead of auto-sending. Review it and click Send when ready.

## Build Check

Before packaging, you can check the JavaScript syntax:

```bash
node --check content/scripts/zotero-codex-chat.js
node --check content/scripts/chat-window.js
```

## Notes

- This plugin targets Zotero 9 and declares compatibility as `6.999` to `9.*` for Zotero 9-compatible plugin loading.
- Codex `app-server` behavior may change across Codex versions.
- Zotero MCP requests run inside Zotero; expensive reads can block the Zotero UI.
