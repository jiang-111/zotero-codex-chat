# Zotero Codex Chat

[English README](README.md)

Zotero Codex Chat 是一个面向 Zotero 9 的插件，可以在 Zotero 内嵌入 Codex 聊天面板，用于论文阅读、笔记草拟和轻量文献整理。

## 功能

- 在 Zotero 中打开内嵌 Codex 聊天面板。
- 根据当前选中的 Zotero 条目、集合或 PDF Reader 选中文本生成上下文。
- 在 PDF Reader 中选中文本后点击 **Ask Codex**，把选中文本送入聊天输入框。
- 提供论文总结、相关文献检索、中文阅读笔记草拟、注释整理等快捷操作。
- 可将最新 Codex 回复写入当前 Zotero 条目的子笔记，写入前会弹出可编辑确认框。
- 支持检查 Zotero MCP 状态，并生成可复制的 Codex MCP 配置片段。
- Zotero MCP 读写调用需要显式确认，避免重型读取在 Zotero 内部执行时造成界面卡顿。

## 依赖

- Zotero 9.x。
- 支持 `app-server` 的 Codex CLI。
- Zotero 能访问到的 Node.js，用于本地 WebSocket bridge。
- 可选但推荐：[`zotero-mcp`](https://github.com/cookjohn/zotero-mcp)。如果希望 Codex 搜索或读取 Zotero 文献库，需要安装并启用它。

## 安装

将插件打包为 XPI：

```bash
cd zotero-codex-chat
zip -r ../zotero-codex-chat.xpi .
```

然后在 Zotero 中安装：

1. 打开 `Tools -> Plugins`。
2. 将生成的 `.xpi` 文件拖入插件窗口。
3. 重启 Zotero。

## 配置 Codex

打开 Zotero Codex Chat 面板后配置：

- `Codex binary path`
- `Node binary path`
- Codex app-server 端口
- Bridge 端口
- Zotero MCP 端口和 server name
- 可选的 model 和工作目录

插件默认不硬编码 Codex 路径。安装后请在插件界面中自行配置。

## 自定义 Codex 路径

`Codex binary path` 可以指向任意可执行文件，例如：

```bash
/usr/local/bin/codex
$HOME/.npm-global/bin/codex
$HOME/.nvm/versions/node/vXX/bin/codex
$HOME/.local/bin/codex-zotero
```

如果 Zotero 是从桌面图标启动，建议使用 wrapper 脚本，而不是依赖 shell 里的 `PATH`。示例：

```bash
#!/usr/bin/env bash
CODEX_BIN="${CODEX_BIN:-codex}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec "$CODEX_BIN" "$@"
```

保存为：

```bash
$HOME/.local/bin/codex-zotero
```

赋予执行权限：

```bash
chmod +x "$HOME/.local/bin/codex-zotero"
```

然后在插件界面把 **Codex binary path** 设置为这个 wrapper 的绝对路径。

如果你要自己打包 XPI，也可以在 `prefs.js` 中设置默认路径：

```js
pref("extensions.zotero.zotero-codex-chat.codex.binaryPath", "/absolute/path/to/codex-zotero");
```

## Zotero MCP 配置

本插件可以复用 [`cookjohn/zotero-mcp`](https://github.com/cookjohn/zotero-mcp) 提供的 MCP server。如果你启用了它，请在 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.zotero]
url = "http://127.0.0.1:23120/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"
```

也可以用脚本生成配置片段：

```bash
./scripts/setup-codex-zotero-mcp.sh 23120 zotero
```

插件不会静默批准 MCP 工具调用。请只确认你确实想执行的调用，尤其是全文读取或库级搜索。

## 使用

打开 Zotero Codex Chat 面板并启动 Codex 后，你可以：

- 询问当前选中的 Zotero 条目。
- 在 PDF Reader 里选中文本并点击 **Ask Codex**。
- 生成阅读笔记，并写回为 Zotero 子笔记。
- 在确认后使用 MCP 工具读取 Zotero 文献库。

PDF Reader 选中文本会先进入聊天输入框，不会自动发送。你可以检查内容后手动点击发送。

## 构建检查

打包前可以检查 JavaScript 语法：

```bash
node --check content/scripts/zotero-codex-chat.js
node --check content/scripts/chat-window.js
```

## 说明

- 本插件面向 Zotero 9，兼容声明为 `6.999` 到 `9.*`。
- Codex `app-server` 行为可能随 Codex 版本变化。
- Zotero MCP 请求在 Zotero 内部执行，耗时读取可能阻塞 Zotero 界面。
