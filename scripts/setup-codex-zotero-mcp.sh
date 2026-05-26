#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${HOME}/.codex/config.toml"
MCP_PORT="${1:-23120}"
SERVER_NAME="${2:-zotero}"

mkdir -p "$(dirname "${CONFIG_FILE}")"
touch "${CONFIG_FILE}"

if grep -q "^\[mcp_servers\.${SERVER_NAME}\]" "${CONFIG_FILE}"; then
  echo "[skip] MCP server '${SERVER_NAME}' already exists in ${CONFIG_FILE}"
  exit 0
fi

cat >> "${CONFIG_FILE}" <<TOML

# Zotero MCP server, added by zotero-codex-chat
[mcp_servers.${SERVER_NAME}]
url = "http://127.0.0.1:${MCP_PORT}/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"

# Safer read-only mode: uncomment this if you do not want Codex to write into Zotero.
# disabled_tools = ["write_note", "write_tag", "write_metadata", "write_item"]
TOML

echo "[ok] Added Zotero MCP server '${SERVER_NAME}' to ${CONFIG_FILE}"
echo "Restart Codex app-server or reopen the Zotero Codex Chat window."
