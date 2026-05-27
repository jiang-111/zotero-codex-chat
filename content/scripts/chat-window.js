/* global Services */
(function () {
  "use strict";

  let addon = null;
  let settings = null;
  let ws = null;
  let nextId = 1;
  let pending = new Map();
  let threadId = null;
  let currentTurnId = null;
  let activeAssistantMessage = null;
  let initialized = false;
  let toolCallRows = new Map();
  let toolStats = { running: 0, done: 0, error: 0 };
  let lastAssistantText = "";
  let activeConversationId = null;
  let restoringHistory = false;
  const externalPromptQueue = [];
  const HISTORY_KEY = "zotero-codex-chat.history.v1";
  const MAX_HISTORY = 30;
  const MAX_MESSAGES_PER_HISTORY = 120;
  const MAX_PROMPT_HISTORY_MESSAGES = 24;
  const MAX_PROMPT_HISTORY_CHARS = 14000;

  function getFrameTargetHint() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const itemKey = params.get("itemKey") || "";
      if (itemKey) return { key: itemKey };
    } catch (_) {}
    return null;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function getAddon() {
    if (addon) return addon;
    const candidates = [];
    try { candidates.push(window.Zotero); } catch (_) {}
    try { candidates.push(window.parent?.Zotero); } catch (_) {}
    try { candidates.push(window.top?.Zotero); } catch (_) {}
    try { candidates.push(window.arguments?.[0]?.Zotero); } catch (_) {}
    try { candidates.push(window.opener?.Zotero); } catch (_) {}
    try { candidates.push(Services?.wm?.getMostRecentWindow?.("navigator:browser")?.Zotero); } catch (_) {}

    for (const z of candidates) {
      if (z?.ZoteroCodexChat) {
        addon = z.ZoteroCodexChat;
        return addon;
      }
    }
    throw new Error("Cannot find Zotero.ZoteroCodexChat from this embedded chat frame.");
  }

  function setPill(el, text, cls) {
    if (!el) return;
    el.textContent = text;
    el.className = `pill ${cls || "muted"}`;
  }

  function addMessage(role, content, extraClass, options = {}) {
    const wrap = document.createElement("div");
    wrap.className = `message ${extraClass || role}`;
    const roleEl = document.createElement("div");
    roleEl.className = "role";
    roleEl.textContent = role;
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.textContent = content || "";
    wrap.append(roleEl, contentEl);
    const messages = $("messages") || document.body;
    messages.appendChild(wrap);
    if ($("messages")) $("messages").scrollTop = $("messages").scrollHeight;
    const messageRef = { wrap, contentEl, historyIndex: null };
    if (!options.skipHistory && !restoringHistory && !["tool", "system"].includes(role)) {
      const historyContent = options.historyContent === undefined ? content : options.historyContent;
      messageRef.historyIndex = recordHistoryMessage(role, historyContent || "", extraClass || role);
    }
    return messageRef;
  }

  function appendToActiveAssistant(text) {
    if (!activeAssistantMessage) {
      activeAssistantMessage = addMessage("assistant", "", "assistant");
    }
    activeAssistantMessage.contentEl.textContent += text || "";
    lastAssistantText = activeAssistantMessage.contentEl.textContent;
    updateHistoryMessage(activeAssistantMessage.historyIndex, lastAssistantText);
    if ($("messages")) $("messages").scrollTop = $("messages").scrollHeight;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function loadHistory() {
    try {
      const stored = getAddon().getChatHistory?.();
      if (Array.isArray(stored)) return stored;
    } catch (_) {}
    try {
      const raw = window.localStorage?.getItem(HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveHistory(items) {
    const clean = (Array.isArray(items) ? items : [])
      .filter((item) => item && item.id)
      .slice(0, MAX_HISTORY);
    try {
      getAddon().saveChatHistory?.(clean);
    } catch (_) {}
    try {
      window.localStorage?.setItem(HISTORY_KEY, JSON.stringify(clean));
    } catch (_) {}
  }

  function migrateLocalHistoryIfNeeded() {
    let addonHistory = [];
    try {
      addonHistory = getAddon().getChatHistory?.() || [];
    } catch (_) {}
    if (Array.isArray(addonHistory) && addonHistory.length) return;
    try {
      const raw = window.localStorage?.getItem(HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed) && parsed.length) saveHistory(parsed);
    } catch (_) {}
  }

  function makeConversationTitle(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return "New chat";
    return clean.length > 42 ? `${clean.slice(0, 42)}...` : clean;
  }

  function ensureActiveConversation(titleHint) {
    if (activeConversationId) return activeConversationId;
    const history = loadHistory();
    const id = `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = nowIso();
    history.unshift({
      id,
      title: makeConversationTitle(titleHint),
      createdAt: now,
      updatedAt: now,
      threadId: threadId || null,
      messages: [],
    });
    activeConversationId = id;
    saveHistory(history);
    renderHistoryList();
    return id;
  }

  function updateActiveConversation(mutator) {
    if (!activeConversationId) return null;
    const history = loadHistory();
    const index = history.findIndex((item) => item.id === activeConversationId);
    if (index < 0) return null;
    const item = history[index];
    mutator(item);
    item.updatedAt = nowIso();
    if (threadId) item.threadId = threadId;
    history.splice(index, 1);
    history.unshift(item);
    saveHistory(history);
    renderHistoryList();
    return item;
  }

  function getActiveConversation() {
    if (!activeConversationId) return null;
    return loadHistory().find((item) => item.id === activeConversationId) || null;
  }

  function normalizeHistoryText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function recordHistoryMessage(role, content, extraClass) {
    ensureActiveConversation(content);
    let savedIndex = null;
    updateActiveConversation((item) => {
      item.messages = Array.isArray(item.messages) ? item.messages : [];
      if ((!item.title || item.title === "New chat") && role === "user") {
        item.title = makeConversationTitle(content);
      }
      item.messages.push({
        role,
        content: String(content || ""),
        extraClass: extraClass || role,
        ts: nowIso(),
      });
      if (item.messages.length > MAX_MESSAGES_PER_HISTORY) {
        item.messages = item.messages.slice(-MAX_MESSAGES_PER_HISTORY);
      }
      savedIndex = item.messages.length - 1;
    });
    return savedIndex;
  }

  function updateHistoryMessage(historyIndex, content) {
    if (historyIndex === null || historyIndex === undefined) return;
    updateActiveConversation((item) => {
      const msg = Array.isArray(item.messages) ? item.messages[historyIndex] : null;
      if (msg) msg.content = String(content || "");
    });
  }

  function formatHistoryDate(value) {
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  function renderHistoryList() {
    const list = $("historyList");
    if (!list) return;
    const history = loadHistory();
    list.textContent = "";
    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "history-meta";
      empty.textContent = "No saved chats yet.";
      list.appendChild(empty);
      return;
    }
    for (const item of history) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `history-item${item.id === activeConversationId ? " active" : ""}`;
      row.title = item.title || "Untitled chat";
      const title = document.createElement("div");
      title.className = "history-title";
      title.textContent = item.title || "Untitled chat";
      const meta = document.createElement("div");
      meta.className = "history-meta";
      meta.textContent = formatHistoryDate(item.updatedAt);
      row.append(title, meta);
      row.addEventListener("click", () => loadConversation(item.id));
      list.appendChild(row);
    }
  }

  function clearMessagesView() {
    const messages = $("messages");
    if (messages) messages.textContent = "";
    activeAssistantMessage = null;
    lastAssistantText = "";
    resetToolActivity();
  }

  function loadConversation(id) {
    const item = loadHistory().find((entry) => entry.id === id);
    if (!item) return;
    activeConversationId = item.id;
    threadId = item.threadId || null;
    currentTurnId = null;
    clearMessagesView();
    restoringHistory = true;
    try {
      for (const msg of item.messages || []) {
        const ref = addMessage(msg.role || "assistant", msg.content || "", msg.extraClass || msg.role || "assistant", { skipHistory: true });
        if ((msg.role || "") === "assistant") lastAssistantText = msg.content || "";
        ref.historyIndex = null;
      }
    } finally {
      restoringHistory = false;
    }
    renderHistoryList();
    showToast("Loaded chat history");
  }

  function saveCurrentConversation() {
    const active = getActiveConversation();
    if (!active && !$("messages")?.children?.length) {
      showToast("No chat to save");
      return;
    }
    ensureActiveConversation("New chat");
    updateActiveConversation((item) => {
      if (!item.title || item.title === "New chat") {
        const firstUser = (item.messages || []).find((msg) => msg.role === "user");
        item.title = makeConversationTitle(firstUser?.content || item.title);
      }
    });
    showToast("Chat saved");
  }

  function clearHistory() {
    if (!window.confirm("Clear only Zotero Codex Chat local history? Zotero notes, PDFs, and Codex CLI history will not be changed.")) return;
    saveHistory([]);
    activeConversationId = null;
    threadId = null;
    currentTurnId = null;
    clearMessagesView();
    renderHistoryList();
    showToast("History cleared");
  }

  function setBusy(busy) {
    $("sendBtn").disabled = busy;
    $("interruptBtn").disabled = !busy;
  }

  function showToast(text) {
    const el = $("toast");
    if (!el) return;
    el.textContent = text || "";
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 1800);
  }

  function renderSettings() {
    settings = getAddon().getSettings();
    $("binaryPath").value = settings.binaryPath || "";
    $("nodeBinaryPath").value = settings.nodeBinaryPath || "";
    $("appServerPort").value = settings.appServerPort || 45123;
    $("bridgePort").value = settings.bridgePort || 45133;
    $("mcpPort").value = settings.mcpPort || 23120;
    $("mcpServerName").value = settings.mcpServerName || "zotero";
    $("model").value = settings.model || "";
    $("cwd").value = settings.configuredCwd || "";
    $("extraArgs").value = settings.extraArgs || "";
    $("includeSelectionContext").checked = !!settings.includeSelectionContext;
    const contextMode = $("contextMode");
    if (contextMode) contextMode.value = settings.contextMode || "auto";
    $("systemInstruction").value = settings.systemInstruction || "";
    $("mcpConfig").value = getAddon().buildCodexMCPToml();
  }

  function collectSettings() {
    return {
      binaryPath: $("binaryPath").value,
      nodeBinaryPath: $("nodeBinaryPath").value,
      appServerPort: Number($("appServerPort").value),
      bridgePort: Number($("bridgePort").value),
      mcpPort: Number($("mcpPort").value),
      mcpServerName: $("mcpServerName").value,
      model: $("model").value,
      cwd: $("cwd").value,
      extraArgs: $("extraArgs").value,
      includeSelectionContext: $("includeSelectionContext").checked,
      contextMode: $("contextMode") ? $("contextMode").value : "auto",
      systemInstruction: $("systemInstruction").value,
    };
  }

  function saveSettings() {
    settings = getAddon().saveSettings(collectSettings());
    renderSettings();
    refreshContext();
  }

  function currentContextMode() {
    const el = $("contextMode");
    return el ? el.value : "auto";
  }

  function refreshContext() {
    try {
      const text = getAddon().formatContextForPrompt(currentContextMode());
      $("contextPreview").textContent = text || "No context will be attached for the current mode.";
    } catch (e) {
      $("contextPreview").textContent = `Failed to read Zotero context: ${e}`;
    }
  }

  async function refreshMCPStatus() {
    settings = getAddon().getSettings();
    const url = `http://127.0.0.1:${settings.mcpPort}/mcp/status`;
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      const tools = Array.isArray(json.availableTools) ? json.availableTools.length : "?";
      setPill($("mcpStatus"), `MCP: connected, ${tools} tools`, "ok");
      return json;
    } catch (e) {
      setPill($("mcpStatus"), `MCP: offline (${settings.mcpPort})`, "bad");
      return null;
    }
  }

  function refreshCodexStatus() {
    try {
      const running = getAddon().isCodexAppServerRunning();
      const bridge = getAddon().isCodexBridgeRunning?.();
      if (ws && ws.readyState === WebSocket.OPEN && initialized) {
        setPill($("codexStatus"), "Codex: connected via bridge", "ok");
      } else if (bridge) {
        setPill($("codexStatus"), "Codex: bridge running", "warn");
      } else if (running) {
        setPill($("codexStatus"), "Codex: process running", "warn");
      } else {
        setPill($("codexStatus"), "Codex: stopped", "muted");
      }
    } catch (_) {}
  }

  async function refreshAllStatus() {
    await refreshMCPStatus();
    refreshCodexStatus();
  }

  function connectWebSocket() {
    settings = getAddon().getSettings();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve(ws);
    }

    return new Promise((resolve, reject) => {
      const url = getAddon().getClientWebSocketURL ? getAddon().getClientWebSocketURL() : `ws://127.0.0.1:${settings.appServerPort}`;
      const socket = new WebSocket(url);
      ws = socket;

      const timer = setTimeout(() => {
        reject(new Error(`Timed out connecting to ${url}`));
      }, 8000);

      socket.onopen = async () => {
        clearTimeout(timer);
        try {
          await initializeCodexConnection();
          refreshCodexStatus();
          resolve(socket);
        } catch (e) {
          reject(e);
        }
      };

      socket.onerror = () => {
        clearTimeout(timer);
        refreshCodexStatus();
        reject(new Error(`Failed to connect to Codex app-server at ${url}`));
      };

      socket.onclose = () => {
        initialized = false;
        ws = null;
        refreshCodexStatus();
      };

      socket.onmessage = (event) => {
        handleCodexMessage(event.data);
      };
    });
  }

  function sendRaw(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex WebSocket is not open.");
    }
    ws.send(JSON.stringify(message));
  }

  function request(method, params) {
    const id = nextId++;
    const msg = { id, method, params: params || {} };
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Codex request timed out: ${method}`));
        }
      }, 120000);
    });
    sendRaw(msg);
    return promise;
  }

  function notify(method, params) {
    sendRaw({ method, params: params || {} });
  }

  async function initializeCodexConnection() {
    if (initialized) return;
    await request("initialize", {
      clientInfo: {
        name: "zotero_codex_chat",
        title: "Zotero Codex Chat",
        version: "0.1.3",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "thread/status/changed",
          "thread/tokenUsage/updated",
          "turn/plan/updated",
          "mcpServer/startupStatus/updated",
          "app/list/updated"
        ],
      },
    });
    notify("initialized", {});
    initialized = true;
  }

  function getDeltaText(msg) {
    const p = msg.params || {};
    return p.delta || p.text || p.content || p.chunk || "";
  }

  function extractItemText(item) {
    if (!item) return "";
    if (typeof item.text === "string") return item.text;
    if (typeof item.message === "string") return item.message;
    if (Array.isArray(item.content)) {
      return item.content
        .map((part) => part?.text || part?.content || part?.value || "")
        .filter(Boolean)
        .join("");
    }
    return "";
  }

  function summarizeToolItem(item) {
    if (!item) return "";
    const server = item.server ? `${item.server}.` : "";
    const tool = item.tool || item.name || item.toolName || "tool";
    const status = item.status ? ` (${item.status})` : "";
    return `${server}${tool}${status}`;
  }

  function toolKey(item) {
    if (!item) return `tool-${Date.now()}-${Math.random()}`;
    return item.id || item.callId || item.requestId || item.toolCallId || item.name || `tool-${Date.now()}-${Math.random()}`;
  }

  function compactToolArgs(item) {
    const args = item?.arguments || item?.args || item?.input || item?.params || null;
    if (!args) return "";
    let text = "";
    try {
      text = typeof args === "string" ? args : JSON.stringify(args);
    } catch (_) {
      text = String(args);
    }
    return text.length > 260 ? text.slice(0, 260) + "…" : text;
  }

  function resetToolActivity() {
    toolCallRows = new Map();
    toolStats = { running: 0, done: 0, error: 0 };
    const list = $("toolList");
    if (list) list.textContent = "";
    updateToolSummary();
  }

  function updateToolSummary() {
    const el = $("toolSummary");
    if (!el) return;
    const total = toolStats.running + toolStats.done + toolStats.error;
    if (!total) {
      el.textContent = "工具调用：0";
      return;
    }
    const parts = [];
    if (toolStats.running) parts.push(`运行中 ${toolStats.running}`);
    if (toolStats.done) parts.push(`完成 ${toolStats.done}`);
    if (toolStats.error) parts.push(`失败 ${toolStats.error}`);
    el.textContent = `工具调用：${total}（${parts.join(" / ")}）`;
  }

  function addOrUpdateToolActivity(status, item, note) {
    const list = $("toolList");
    if (!list || !item) return;
    const key = toolKey(item);
    let row = toolCallRows.get(key);
    const previous = row?.dataset?.status || null;
    if (!row) {
      row = document.createElement("div");
      row.className = "tool-row";
      row.dataset.status = "running";
      const dot = document.createElement("span");
      dot.className = "tool-dot";
      const body = document.createElement("div");
      const title = document.createElement("div");
      title.className = "tool-title";
      const meta = document.createElement("div");
      meta.className = "tool-meta";
      body.append(title, meta);
      row.append(dot, body);
      row._title = title;
      row._meta = meta;
      list.appendChild(row);
      toolCallRows.set(key, row);
      toolStats.running += 1;
    }

    const next = status || "running";
    if (previous !== next) {
      if (previous && toolStats[previous] > 0) toolStats[previous] -= 1;
      toolStats[next] = (toolStats[next] || 0) + 1;
      row.dataset.status = next;
    }
    row.className = `tool-row ${next === "running" ? "" : next}`;
    row._title.textContent = summarizeToolItem(item) || "Zotero MCP tool";
    const args = compactToolArgs(item);
    const suffix = note ? note : args ? args : next === "running" ? "调用中…" : next === "done" ? "已完成" : "调用失败";
    row._meta.textContent = suffix;
    updateToolSummary();
  }

  function renderItem(item, prefix) {
    if (!item) return;
    const type = item.type || "item";
    if (type === "agentMessage") {
      const text = extractItemText(item);
      // Delta events normally stream the text. Only render the completed item if
      // no assistant bubble has been created yet, to avoid duplicate output.
      if (text && !activeAssistantMessage) appendToActiveAssistant(text);
      return;
    }

    // Keep the normal Zotero pane clean. Do not dump raw protocol events.
    // Tool calls are summarized in a collapsible panel.
    if (type === "mcpToolCall" || type === "dynamicToolCall") {
      if (prefix === "started") {
        addOrUpdateToolActivity("running", item);
        showToast(`调用 ${summarizeToolItem(item)}`);
        return;
      }
      if (item.error || item.status === "failed" || item.status === "error") {
        addOrUpdateToolActivity("error", item, item.error ? safeJson(item.error).slice(0, 260) : "调用失败");
        return;
      }
      if (prefix === "completed") {
        addOrUpdateToolActivity("done", item);
        return;
      }
    }
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return String(value);
    }
  }


  function getLatestAssistantText() {
    const text = String(lastAssistantText || "").trim();
    if (text) return text;
    const nodes = Array.from(document.querySelectorAll(".message.assistant .content"));
    const last = nodes.at(-1);
    return String(last?.textContent || "").trim();
  }

  function extractToolNameFromParams(params) {
    const p = params || {};
    const candidates = [
      p.tool,
      p.toolName,
      p.name,
      p.request?.tool,
      p.request?.toolName,
      p.request?.name,
      p.meta?.tool,
      p.meta?.toolName,
      p.request?.meta?.tool,
      p.request?.meta?.toolName,
      p.call?.tool,
      p.call?.name,
      p.item?.tool,
      p.item?.name,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    const text = safeJson(p);
    const m = text.match(/"(?:tool|toolName|name)"\s*:\s*"([^"]+)"/);
    return m ? m[1] : "";
  }

  function isWriteToolName(name, params) {
    const lower = `${name || ""} ${safeJson(params || {})}`.toLowerCase();
    return /\b(write|update|delete|create|add|remove|set|modify|edit|save)_/.test(lower) ||
      /\b(write_note|write_tag|write_metadata|write_item|delete_collection|create_collection|add_items_to_collection|remove_items_from_collection)\b/.test(lower);
  }

  function isReadToolName(name, params) {
    const lower = `${name || ""} ${safeJson(params || {})}`.toLowerCase();
    return /\b(search|get|list|find|read|semantic)_/.test(lower) ||
      /\b(search_library|get_item_details|get_content|get_annotations|search_annotations|get_collections|semantic_search|find_similar)\b/.test(lower);
  }

  function acceptServerRequest(msg, result) {
    sendRaw({ id: msg.id, result: result || { action: "accept", content: {} } });
  }

  function confirmWriteMCP(method, params, label) {
    const toolName = extractToolNameFromParams(params) || "unknown tool";
    return window.confirm(`${label || "Codex 想执行会修改 Zotero 的操作"}:\n\n工具：${toolName}\n\n${approvalPreview(method, params)}\n\n允许这一次吗？`);
  }

  function confirmReadMCP(method, params) {
    const toolName = extractToolNameFromParams(params) || "unknown tool";
    return window.confirm(
      `Codex 想调用 Zotero MCP 只读工具。\n\n工具：${toolName}\n\n` +
      `注意：全文读取、批注读取、全库搜索可能会让 Zotero 暂时卡住。\n\n${approvalPreview(method, params)}\n\n允许这一次吗？`
    );
  }

  function showNoteConfirmDialog(initialContent, target) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      const dialog = document.createElement("div");
      dialog.className = "note-modal";

      const title = document.createElement("h2");
      title.textContent = "写入 Zotero Note";
      const desc = document.createElement("p");
      desc.className = "modal-desc";
      desc.textContent = target
        ? `将把下面内容写入当前条目的子笔记：${target.title || target.key || "Untitled"}`
        : "将把下面内容写入当前选中条目的子笔记。";

      const textarea = document.createElement("textarea");
      textarea.className = "note-preview";
      textarea.value = String(initialContent || "").trim();
      textarea.spellcheck = false;

      const row = document.createElement("div");
      row.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "primary";
      ok.textContent = "确认写入";
      row.append(cancel, ok);
      dialog.append(title, desc, textarea, row);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const close = (value) => {
        overlay.remove();
        resolve(value);
      };
      cancel.addEventListener("click", () => close(null));
      ok.addEventListener("click", () => close(textarea.value));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close(null);
      });
      textarea.focus();
    });
  }

  function firstAvailableDecision(params, preferred) {
    const available = params?.availableDecisions;
    if (!Array.isArray(available) || !available.length) return preferred;
    return available.includes(preferred) ? preferred : available[0];
  }

  function approvalPreview(method, params) {
    const p = params || {};
    if (method === "item/commandExecution/requestApproval") {
      const cmd = Array.isArray(p.command) ? p.command.join(" ") : (p.command || "");
      return [
        p.reason || "Codex wants to run a command.",
        cmd ? `Command: ${cmd}` : "",
        p.cwd ? `cwd: ${p.cwd}` : "",
      ].filter(Boolean).join("\n");
    }
    if (method === "item/fileChange/requestApproval") {
      return [
        p.reason || "Codex wants to modify files.",
        p.grantRoot ? `grantRoot: ${p.grantRoot}` : "",
      ].filter(Boolean).join("\n");
    }
    if (method === "item/permissions/requestApproval") {
      return [
        p.reason || "Codex requests additional permissions.",
        p.cwd ? `cwd: ${p.cwd}` : "",
        safeJson(p.permissions || {}).slice(0, 2000),
      ].filter(Boolean).join("\n");
    }
    if (method === "mcpServer/elicitation/request") {
      return [
        p.serverName ? `MCP server: ${p.serverName}` : "MCP server request",
        p.message || p.request?.message || "Codex requests approval/input for an MCP tool.",
        safeJson(p.requestedSchema || p.request?.requestedSchema || {}).slice(0, 2000),
      ].filter(Boolean).join("\n");
    }
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      return [
        p.message || p.prompt || "Codex requests additional user input for a tool call.",
        safeJson(p.questions || p.options || p).slice(0, 2000),
      ].filter(Boolean).join("\n");
    }
    return `${method}\n${safeJson(params).slice(0, 3000)}`;
  }

  function handleServerRequest(msg) {
    const method = msg.method || "server/request";
    const params = msg.params || {};

    // File changes, shell commands and permission expansion are editing-like
    // actions. Keep explicit confirmation for these.
    if (method === "item/commandExecution/requestApproval") {
      const ok = window.confirm(`Codex requests command approval:\n\n${approvalPreview(method, params)}\n\nAllow?`);
      sendRaw({ id: msg.id, result: { decision: ok ? firstAvailableDecision(params, "accept") : "decline" } });
      return true;
    }

    if (method === "item/fileChange/requestApproval") {
      const ok = window.confirm(`Codex requests file-change approval:\n\n${approvalPreview(method, params)}\n\nAllow?`);
      sendRaw({ id: msg.id, result: { decision: ok ? firstAvailableDecision(params, "accept") : "decline" } });
      return true;
    }

    if (method === "item/permissions/requestApproval") {
      const ok = window.confirm(`Codex requests additional permissions:\n\n${approvalPreview(method, params)}\n\nAllow only the requested subset?`);
      sendRaw({
        id: msg.id,
        result: ok ? { scope: "turn", permissions: params.permissions || {} } : { scope: "turn", permissions: {} },
      });
      return true;
    }

    if (method === "mcpServer/elicitation/request") {
      const toolName = extractToolNameFromParams(params);
      if (isWriteToolName(toolName, params)) {
        const ok = confirmWriteMCP(method, params, "Codex 想调用会修改 Zotero 的 MCP 工具");
        acceptServerRequest(msg, ok ? { action: "accept", content: {} } : { action: "decline", content: null });
        return true;
      }
      if (isReadToolName(toolName, params)) {
        const ok = confirmReadMCP(method, params);
        acceptServerRequest(msg, ok ? { action: "accept", content: {} } : { action: "decline", content: null });
        addOrUpdateToolActivity(ok ? "running" : "error", { name: toolName || "MCP read", status: ok ? "approved" : "declined" }, ok ? "只读调用已同意" : "只读调用已拒绝");
        return true;
      }
      // Unknown MCP requests might still be writes. Confirm once instead of
      // silently approving an unclassified operation.
      const ok = window.confirm(`Codex requests MCP input/approval:\n\n${approvalPreview(method, params)}\n\nAllow?`);
      acceptServerRequest(msg, ok ? { action: "accept", content: {} } : { action: "decline", content: null });
      return true;
    }

    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      const toolName = extractToolNameFromParams(params);
      if (isWriteToolName(toolName, params)) {
        const ok = confirmWriteMCP(method, params, "Codex 想调用会修改 Zotero 的工具");
        sendRaw({ id: msg.id, result: ok ? { answers: {} } : { answers: {}, declined: true } });
        return true;
      }
      if (isReadToolName(toolName, params)) {
        const ok = confirmReadMCP(method, params);
        sendRaw({ id: msg.id, result: ok ? { answers: {} } : { answers: {}, declined: true } });
        addOrUpdateToolActivity(ok ? "running" : "error", { name: toolName || "tool", status: ok ? "approved" : "declined" }, ok ? "只读调用已同意" : "只读调用已拒绝");
        return true;
      }
      const ok = window.confirm(`Codex requests tool input/approval:\n\n${approvalPreview(method, params)}\n\nContinue?`);
      sendRaw({ id: msg.id, result: ok ? { answers: {} } : { answers: {}, declined: true } });
      return true;
    }

    if (method === "item/tool/call") {
      sendRaw({
        id: msg.id,
        result: { success: false, contentItems: [{ type: "inputText", text: "Unsupported client-side dynamic tool call." }] },
      });
      return true;
    }

    return false;
  }


  function handleCodexMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      addMessage("error", `Invalid Codex message: ${raw}`, "error");
      return;
    }

    if (msg.id && msg.method) {
      if (handleServerRequest(msg)) return;
    }

    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || safeJson(msg.error)));
      else p.resolve(msg.result);
      return;
    }

    const method = msg.method || "";
    const params = msg.params || {};

    if (method === "thread/started") {
      if (params.thread?.id) threadId = params.thread.id;
      updateActiveConversation((item) => { item.threadId = threadId; });
      return;
    }
    if (method === "turn/started") {
      currentTurnId = params.turn?.id || null;
      activeAssistantMessage = null;
      resetToolActivity();
      setBusy(true);
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn || {};
      const status = turn.status || "completed";
      if (status === "failed") {
        addMessage("error", `Turn failed: ${safeJson(turn.error || params.error || {})}`, "error");
      }
      activeAssistantMessage = null;
      currentTurnId = null;
      setBusy(false);
      return;
    }
    if (method === "item/agentMessage/delta") {
      appendToActiveAssistant(getDeltaText(msg));
      return;
    }
    if (method === "item/plan/delta") {
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      return;
    }
    if (method === "item/started") {
      renderItem(params.item, "started");
      return;
    }
    if (method === "item/completed") {
      renderItem(params.item, "completed");
      return;
    }
    if (method === "turn/plan/updated") {
      return;
    }
    if (method === "error") {
      addMessage("error", safeJson(params.error || params), "error");
      return;
    }

    // Hide unknown protocol notifications by default. They are not user-facing chat text.
    if (method.startsWith("item/") || method.startsWith("turn/") || method.startsWith("thread/") || method.startsWith("serverRequest/")) {
      return;
    }
  }

  async function isCodexHttpReady() {
    settings = getAddon().getSettings();
    try {
      const res = await fetch(`http://127.0.0.1:${settings.appServerPort}/readyz`, { method: "GET", cache: "no-store" });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  async function waitCodexReady(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      if (await isCodexHttpReady()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async function ensureCodexReady() {
    settings = getAddon().getSettings();
    let ready = await isCodexHttpReady();
    if (!ready) {
      const started = getAddon().startCodexAppServer();
      if (!started.ok) throw new Error(started.message);
      refreshCodexStatus();
      ready = await waitCodexReady(started.alreadyRunning ? 1200 : 8000);
      if (!ready) throw new Error(`Codex app-server process started but /readyz did not become ready on port ${settings.appServerPort}.`);
    }
    const bridge = getAddon().startCodexBridge ? getAddon().startCodexBridge() : { ok: true };
    if (!bridge.ok) throw new Error(bridge.message);
    await new Promise((r) => setTimeout(r, bridge.alreadyRunning ? 0 : 500));
    await connectWebSocket();
  }

  async function ensureThread() {
    if (threadId) return threadId;
    settings = getAddon().getSettings();
    const params = {
      cwd: settings.cwd,
      approvalPolicy: "on-request",
      serviceName: "zotero_codex_chat",
    };
    if (settings.model) params.model = settings.model;
    const result = await request("thread/start", params);
    threadId = result?.thread?.id || threadId;
    if (!threadId) throw new Error("Codex did not return a thread id.");
    updateActiveConversation((item) => { item.threadId = threadId; });
    return threadId;
  }

  function buildLocalHistoryContext(userText) {
    const active = getActiveConversation();
    const source = Array.isArray(active?.messages) ? active.messages : [];
    if (!source.length) return "";

    const latestUser = normalizeHistoryText(userText);
    const messages = source
      .filter((msg) => ["user", "assistant"].includes(msg?.role) && String(msg?.content || "").trim())
      .map((msg) => ({
        role: msg.role,
        content: String(msg.content || "").trim(),
      }));

    const last = messages.at(-1);
    if (last?.role === "user" && normalizeHistoryText(last.content) === latestUser) {
      messages.pop();
    }
    if (!messages.length) return "";

    const recent = messages.slice(-MAX_PROMPT_HISTORY_MESSAGES);
    const lines = [];
    let total = 0;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const msg = recent[i];
      const label = msg.role === "user" ? "User" : "Assistant";
      const entry = `${label}: ${msg.content}`;
      total += entry.length;
      if (total > MAX_PROMPT_HISTORY_CHARS && lines.length) break;
      lines.unshift(entry);
    }
    return lines.join("\n\n");
  }

  function buildPrompt(userText) {
    settings = getAddon().getSettings();
    const parts = [];
    if (settings.systemInstruction) {
      parts.push(`[System instruction for this Zotero chat]\n${settings.systemInstruction}`);
    }
    const localHistory = buildLocalHistoryContext(userText);
    if (localHistory) {
      parts.push(`[Local chat history loaded from this Zotero Codex Chat panel]\nContinue the conversation using this visible local transcript as context. It may be the only available history if the Codex service or bridge was restarted.\n\n${localHistory}`);
    }
    const ctx = getAddon().formatContextForPrompt(currentContextMode());
    if (ctx) {
      parts.push(`[Zotero context]\n${ctx}`);
      parts.push(`[MCP safety]\nThe Zotero MCP server may be available as '${settings.mcpServerName || "zotero"}', but MCP calls run inside Zotero and can freeze the UI. Use the provided context first. Do not call Zotero MCP tools unless the user explicitly asks for library/PDF/annotation lookup, and expect a confirmation prompt before each MCP call.`);
    }
    parts.push(`[User request]\n${userText}`);
    return parts.join("\n\n");
  }



  function receiveExternalPrompt(payload) {
    const p = typeof payload === "string" ? { prompt: payload } : (payload || {});
    const prompt = String(p.prompt || "").trim();
    if (!prompt) return;
    if (!document.body || !$('promptInput')) {
      externalPromptQueue.push(p);
      return;
    }
    $("promptInput").value = prompt;
    showToast("已填入选中文本，点击发送继续");
  }

  function drainExternalPromptQueue() {
    try {
      const fromAddon = getAddon().drainExternalPrompts?.() || [];
      for (const payload of fromAddon) externalPromptQueue.push(payload);
    } catch (_) {}
    while (externalPromptQueue.length) {
      receiveExternalPrompt(externalPromptQueue.shift());
    }
  }

  window.ZoteroCodexChatFrameAPI = { receiveExternalPrompt };

  async function submitPromptText(text, displayText) {
    const clean = String(text || "").trim();
    if (!clean) return;
    ensureActiveConversation(displayText || clean);
    addMessage("user", displayText || clean, "user", { historyContent: clean });
    $("promptInput").value = "";
    setBusy(true);
    try {
      await ensureCodexReady();
      const id = await ensureThread();
      await request("turn/start", {
        threadId: id,
        input: [{ type: "text", text: buildPrompt(clean) }],
      });
    } catch (e) {
      addMessage("error", String(e.message || e), "error");
      setBusy(false);
    }
  }

  async function sendPrompt() {
    const text = $("promptInput").value.trim();
    await submitPromptText(text);
  }

  function quickPrompt(kind) {
    const templates = {
      summarize: {
        label: "总结当前文献",
        prompt: "请调用 Zotero MCP，读取当前选中的文献条目、摘要、PDF/附件全文和批注，然后用中文总结：\n1. 研究问题\n2. 方法与数据\n3. 主要贡献\n4. 局限性\n5. 值得放进相关工作的观点\n要求：优先使用当前选中文献的 key；不要写入 Zotero；如果没有选中文献，请先说明需要我选中文献。",
      },
      search: {
        label: "搜索全库相关文献",
        prompt: "请根据当前 Zotero 上下文，调用 Zotero MCP 在我的 Zotero 文献库中搜索相关文献。\n要求：\n1. 如果当前选中了文献，请围绕它的主题、标题、摘要关键词搜索；\n2. 如果当前选中了 collection，请围绕该 collection 的主题搜索；\n3. 列出最相关的 10 条，包括标题、作者/年份、为什么相关；\n4. 不要写入 Zotero。",
      },
      note: {
        label: "生成阅读笔记",
        prompt: "请调用 Zotero MCP 读取当前选中文献的元数据、摘要、PDF/附件全文和批注，生成一份中文 Markdown 阅读笔记。\n结构固定为：\n# 中文阅读笔记\n## 基本信息\n## 一句话概括\n## 研究问题\n## 方法\n## 主要贡献\n## 关键证据\n## 局限性\n## 可引用观点\n## 和我的研究/项目的关系\n要求：只输出笔记内容；不要写入 Zotero。",
      },
      annotations: {
        label: "总结批注",
        prompt: "请调用 Zotero MCP 读取当前选中文献或其 PDF 附件的 annotations / notes，并用中文整理：\n1. 批注主题分组\n2. 每组关键观点\n3. 可能对应的论文段落/页码信息\n4. 适合写入阅读笔记的摘要\n要求：不要写入 Zotero；如果当前条目没有批注，请说明没有读取到批注。",
      },
    };
    const item = templates[kind];
    if (!item) return;
    submitPromptText(item.prompt, item.label);
  }


  async function writeLatestAssistantNote() {
    const content = getLatestAssistantText();
    if (!content) {
      showToast("没有可写入的 Codex 回复");
      return;
    }
    let target = null;
    try {
      target = getAddon().getPrimaryNoteTarget?.(getFrameTargetHint());
    } catch (_) {}
    if (!target) {
      addMessage("error", "请先在 Zotero 中选中一篇文献，再写入 Note。", "error");
      return;
    }
    const edited = await showNoteConfirmDialog(content, target);
    if (edited === null) {
      showToast("已取消写入");
      return;
    }
    setBusy(true);
    try {
      const result = await getAddon().writeMarkdownNoteToSelectedItem(edited, "Codex 阅读笔记", target);
      if (!result?.ok) throw new Error(result?.message || "写入失败");
      showToast("已写入 Zotero Note");
      addMessage("assistant", `已写入 Zotero Note：${result.parentTitle || result.parentKey || "当前条目"}`, "assistant");
    } catch (e) {
      addMessage("error", `写入 Zotero Note 失败：${e.message || e}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function newThread() {
    const active = getActiveConversation();
    if (active?.messages?.length) saveCurrentConversation();
    threadId = null;
    currentTurnId = null;
    activeConversationId = null;
    clearMessagesView();
    ensureActiveConversation("New chat");
    renderHistoryList();
    showToast("New thread");
  }

  async function interruptTurn() {
    if (!threadId || !currentTurnId) {
      return;
    }
    try {
      await request("turn/interrupt", { threadId, turnId: currentTurnId });
    } catch (e) {
      addMessage("error", `Interrupt failed: ${e.message || e}`, "error");
    }
  }

  async function startCodex() {
    saveSettings();
    try {
      let ready = await isCodexHttpReady();
      if (!ready) {
        const result = getAddon().startCodexAppServer();
        if (!result.ok) {
          addMessage("error", result.message, "error");
          refreshCodexStatus();
          return;
        }
        ready = await waitCodexReady(result.alreadyRunning ? 1200 : 8000);
        if (!ready) throw new Error(`Codex app-server did not report /readyz=200 on port ${getAddon().getSettings().appServerPort}.`);
      } else {
      }

      const bridge = getAddon().startCodexBridge ? getAddon().startCodexBridge() : { ok: true, message: "No bridge layer available." };
      if (!bridge.ok) throw new Error(bridge.message);
      await new Promise((r) => setTimeout(r, bridge.alreadyRunning ? 0 : 500));
      await connectWebSocket();
    } catch (e) {
      addMessage("error", `Codex connection failed: ${e.message || e}`, "error");
    }
    refreshCodexStatus();
  }

  function stopCodex() {
    try {
      if (ws) ws.close();
    } catch (_) {}
    ws = null;
    initialized = false;
    pending.clear();
    const bridgeResult = getAddon().stopCodexBridge ? getAddon().stopCodexBridge() : { ok: true, message: "" };
    if (bridgeResult.message && !bridgeResult.ok) addMessage("error", bridgeResult.message, "error");
    const result = getAddon().stopCodexAppServer();
    if (!result.ok) addMessage("error", result.message, "error");
    refreshCodexStatus();
  }

  async function copyMcpConfig() {
    const text = getAddon().buildCodexMCPToml();
    $("mcpConfig").value = text;
    try {
      await navigator.clipboard.writeText(text);
      showToast("MCP config copied");
    } catch (_) {
      $("mcpConfig").focus();
      $("mcpConfig").select();
      showToast("Select and copy the config manually");
    }
  }

  function bindEvents() {
    $("saveSettingsBtn").addEventListener("click", saveSettings);
    $("startCodexBtn").addEventListener("click", startCodex);
    $("stopCodexBtn").addEventListener("click", stopCodex);
    $("refreshStatusBtn").addEventListener("click", refreshAllStatus);
    $("copyMcpConfigBtn").addEventListener("click", copyMcpConfig);
    $("refreshContextBtn").addEventListener("click", refreshContext);
    $("contextMode")?.addEventListener("change", () => { saveSettings(); refreshContext(); });
    $("sendBtn").addEventListener("click", sendPrompt);
    $("quickSummarizeBtn")?.addEventListener("click", () => quickPrompt("summarize"));
    $("quickSearchBtn")?.addEventListener("click", () => quickPrompt("search"));
    $("quickNoteBtn")?.addEventListener("click", () => quickPrompt("note"));
    $("quickAnnotationsBtn")?.addEventListener("click", () => quickPrompt("annotations"));
    $("writeNoteBtn")?.addEventListener("click", writeLatestAssistantNote);
    $("clearToolsBtn")?.addEventListener("click", resetToolActivity);
    $("saveHistoryBtn")?.addEventListener("click", saveCurrentConversation);
    $("clearHistoryBtn")?.addEventListener("click", clearHistory);
    $("newThreadBtn").addEventListener("click", newThread);
    $("interruptBtn").addEventListener("click", interruptTurn);
    $("promptInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendPrompt();
      }
    });
    window.addEventListener("beforeunload", () => {
      try {
        if (ws) ws.close();
      } catch (_) {}
    });
  }

  async function init() {
    try {
      getAddon();
      bindEvents();
      renderSettings();
      refreshContext();
      resetToolActivity();
      migrateLocalHistoryIfNeeded();
      renderHistoryList();
      setBusy(false);
      await refreshAllStatus();
      drainExternalPromptQueue();
    } catch (e) {
      addMessage("error", String(e.message || e), "error");
    }
  }

  window.addEventListener("DOMContentLoaded", init);
})();
