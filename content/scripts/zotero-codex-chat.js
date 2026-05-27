/* global Zotero, Services, Components, rootURI */
(function () {
  "use strict";

  const Cc = Components.classes;
  const Ci = Components.interfaces;

  const ADDON_ID = "zotero-codex-chat@autoagent.my";
  const ADDON_REF = "zotero-codex-chat";
  const PREF_PREFIX = "extensions.zotero.zotero-codex-chat.";
  const MENU_ID = "zotero-codex-chat-menuitem";
  const SEP_ID = "zotero-codex-chat-separator";
  const FALLBACK_MENU_ID = "zotero-codex-chat-fallback-menu";
  const SIDEBAR_ID = "zotero-codex-chat-sidebar";
  const SIDEBAR_IFRAME_ID = "zotero-codex-chat-sidebar-frame";
  const SIDEBAR_STYLE_ID = "zotero-codex-chat-sidebar-style";
  const ITEM_PANE_ID = "zotero-codex-chat-item-pane";
  const ITEM_PANE_IFRAME_ID = "zotero-codex-chat-item-pane-frame";

  function log(message, level) {
    // Keep normal operation quiet. Only write actual errors to Zotero's log.
    if (level !== "error") return;
    const text = `[ZoteroCodexChat] ${message}`;
    try {
      Zotero.logError(text);
    } catch (_) {}
  }

  function prefKey(key) {
    return PREF_PREFIX + key;
  }

  function getPref(key, fallback) {
    try {
      const value = Zotero.Prefs.get(prefKey(key), true);
      return value === undefined || value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function setPref(key, value) {
    Zotero.Prefs.set(prefKey(key), value, true);
  }

  function nsFile(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file;
  }

  function getProfileDirPath() {
    try {
      return Zotero.Profile.dir;
    } catch (_) {
      try {
        return Services.dirsvc.get("ProfD", Ci.nsIFile).path;
      } catch (e) {
        return "";
      }
    }
  }

  function getHomeDirPath() {
    try {
      return Services.dirsvc.get("Home", Ci.nsIFile).path;
    } catch (_) {
      return "";
    }
  }

  function ensureDir(path) {
    const dir = nsFile(path);
    if (!dir.exists()) {
      dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
    }
    return dir;
  }

  function guessWorkingDirectory() {
    const configured = String(getPref("codex.cwd", "") || "").trim();
    if (configured) return configured;
    const profile = getProfileDirPath();
    if (!profile) return getHomeDirPath();
    const workDir = profile + "/zotero-codex-chat-workspace";
    try {
      ensureDir(workDir);
    } catch (e) {
      log(`Failed to create workspace: ${e}`, "error");
    }
    return workDir;
  }


  const BRIDGE_SCRIPT = "#!/usr/bin/env node\n/* Zotero Codex Chat WebSocket bridge.\n * Browser/XUL WebSocket clients may send an Origin header that Codex app-server rejects.\n * This bridge accepts browser WS locally and opens a Node WS client to Codex app-server.\n */\n'use strict';\n\nconst http = require('http');\nconst crypto = require('crypto');\n\nfunction argValue(name, fallback) {\n  const idx = process.argv.indexOf(name);\n  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];\n  return fallback;\n}\n\nconst listenHost = argValue('--host', '127.0.0.1');\nconst listenPort = Number(argValue('--listen', '45133'));\nconst codexHost = argValue('--codex-host', '127.0.0.1');\nconst codexPort = Number(argValue('--codex-port', '45123'));\nconst codexUrl = `ws://${codexHost}:${codexPort}`;\n\nfunction sendFrame(socket, data) {\n  if (!socket || socket.destroyed) return;\n  const payload = Buffer.from(String(data), 'utf8');\n  let header;\n  if (payload.length < 126) {\n    header = Buffer.from([0x81, payload.length]);\n  } else if (payload.length < 65536) {\n    header = Buffer.alloc(4);\n    header[0] = 0x81;\n    header[1] = 126;\n    header.writeUInt16BE(payload.length, 2);\n  } else {\n    header = Buffer.alloc(10);\n    header[0] = 0x81;\n    header[1] = 127;\n    header.writeBigUInt64BE(BigInt(payload.length), 2);\n  }\n  socket.write(Buffer.concat([header, payload]));\n}\n\nfunction closeSocket(socket, code = 1000, reason = '') {\n  if (!socket || socket.destroyed) return;\n  const reasonBuf = Buffer.from(reason, 'utf8');\n  const payload = Buffer.alloc(2 + reasonBuf.length);\n  payload.writeUInt16BE(code, 0);\n  reasonBuf.copy(payload, 2);\n  let header;\n  if (payload.length < 126) {\n    header = Buffer.from([0x88, payload.length]);\n  } else {\n    header = Buffer.from([0x88, 0]);\n  }\n  try { socket.write(Buffer.concat([header, payload])); } catch (_) {}\n  try { socket.end(); } catch (_) {}\n}\n\nfunction parseFrames(buffer) {\n  const messages = [];\n  let offset = 0;\n  while (buffer.length - offset >= 2) {\n    const b0 = buffer[offset];\n    const opcode = b0 & 0x0f;\n    const b1 = buffer[offset + 1];\n    const masked = !!(b1 & 0x80);\n    let len = b1 & 0x7f;\n    let pos = offset + 2;\n    if (len === 126) {\n      if (buffer.length - pos < 2) break;\n      len = buffer.readUInt16BE(pos);\n      pos += 2;\n    } else if (len === 127) {\n      if (buffer.length - pos < 8) break;\n      const big = buffer.readBigUInt64BE(pos);\n      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');\n      len = Number(big);\n      pos += 8;\n    }\n    let mask;\n    if (masked) {\n      if (buffer.length - pos < 4) break;\n      mask = buffer.subarray(pos, pos + 4);\n      pos += 4;\n    }\n    if (buffer.length - pos < len) break;\n    let payload = Buffer.from(buffer.subarray(pos, pos + len));\n    if (masked && mask) {\n      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];\n    }\n    offset = pos + len;\n    if (opcode === 0x1) messages.push({ type: 'text', data: payload.toString('utf8') });\n    else if (opcode === 0x8) messages.push({ type: 'close' });\n    else if (opcode === 0x9) messages.push({ type: 'ping', data: payload });\n  }\n  return { messages, rest: buffer.subarray(offset) };\n}\n\nfunction sendPong(socket, payload) {\n  const body = Buffer.from(payload || Buffer.alloc(0));\n  const header = body.length < 126 ? Buffer.from([0x8a, body.length]) : Buffer.from([0x8a, 0]);\n  try { socket.write(Buffer.concat([header, body])); } catch (_) {}\n}\n\nfunction connectToCodex(clientSocket, queue) {\n  if (typeof WebSocket === 'undefined') {\n    sendFrame(clientSocket, JSON.stringify({ method: 'error', params: { error: 'Node global WebSocket is unavailable. Use Node >= 20/22.' } }));\n    closeSocket(clientSocket, 1011, 'Node WebSocket unavailable');\n    return null;\n  }\n  let codex;\n  try {\n    codex = new WebSocket(codexUrl);\n  } catch (e) {\n    sendFrame(clientSocket, JSON.stringify({ method: 'error', params: { error: `Failed to create Codex WebSocket: ${e.message || e}` } }));\n    closeSocket(clientSocket, 1011, 'Codex connection failed');\n    return null;\n  }\n\n  codex.onopen = () => {\n    for (const msg of queue.splice(0)) codex.send(msg);\n  };\n  codex.onmessage = (event) => {\n    sendFrame(clientSocket, event.data);\n  };\n  codex.onerror = () => {\n    sendFrame(clientSocket, JSON.stringify({ method: 'error', params: { error: `Codex WebSocket error while connecting to ${codexUrl}` } }));\n  };\n  codex.onclose = (event) => {\n    if (!clientSocket.destroyed) {\n      sendFrame(clientSocket, JSON.stringify({ method: 'error', params: { error: `Codex WebSocket closed: ${event.code || ''} ${event.reason || ''}` } }));\n      closeSocket(clientSocket, 1011, 'Codex closed');\n    }\n  };\n  return codex;\n}\n\nconst server = http.createServer((req, res) => {\n  if (req.url === '/readyz' || req.url === '/healthz') {\n    res.writeHead(200, { 'content-type': 'text/plain' });\n    res.end('ok\\n');\n    return;\n  }\n  res.writeHead(404, { 'content-type': 'text/plain' });\n  res.end('not found\\n');\n});\n\nserver.on('upgrade', (req, socket) => {\n  if (req.url !== '/ws') {\n    socket.write('HTTP/1.1 404 Not Found\\r\\n\\r\\n');\n    socket.destroy();\n    return;\n  }\n  const key = req.headers['sec-websocket-key'];\n  if (!key) {\n    socket.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');\n    socket.destroy();\n    return;\n  }\n  const accept = crypto\n    .createHash('sha1')\n    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')\n    .digest('base64');\n  socket.write(\n    'HTTP/1.1 101 Switching Protocols\\r\\n' +\n    'Upgrade: websocket\\r\\n' +\n    'Connection: Upgrade\\r\\n' +\n    `Sec-WebSocket-Accept: ${accept}\\r\\n` +\n    '\\r\\n'\n  );\n\n  const queue = [];\n  const codex = connectToCodex(socket, queue);\n  let buffer = Buffer.alloc(0);\n\n  socket.on('data', (chunk) => {\n    try {\n      buffer = Buffer.concat([buffer, chunk]);\n      const parsed = parseFrames(buffer);\n      buffer = parsed.rest;\n      for (const frame of parsed.messages) {\n        if (frame.type === 'close') {\n          try { codex?.close?.(); } catch (_) {}\n          closeSocket(socket);\n          return;\n        }\n        if (frame.type === 'ping') {\n          sendPong(socket, frame.data);\n          continue;\n        }\n        if (frame.type === 'text') {\n          if (codex && codex.readyState === WebSocket.OPEN) codex.send(frame.data);\n          else queue.push(frame.data);\n        }\n      }\n    } catch (e) {\n      sendFrame(socket, JSON.stringify({ method: 'error', params: { error: `Bridge frame error: ${e.message || e}` } }));\n      closeSocket(socket, 1011, 'Bridge error');\n    }\n  });\n\n  socket.on('close', () => { try { codex?.close?.(); } catch (_) {} });\n  socket.on('error', () => { try { codex?.close?.(); } catch (_) {} });\n});\n\nserver.listen(listenPort, listenHost, () => {\n  console.error(`[zotero-codex-bridge] listening ws://${listenHost}:${listenPort}/ws -> ${codexUrl}`);\n});\n\nprocess.on('SIGTERM', () => server.close(() => process.exit(0)));\nprocess.on('SIGINT', () => server.close(() => process.exit(0)));\n";

  function pathExists(path) {
    try {
      return !!path && nsFile(path).exists();
    } catch (_) {
      return false;
    }
  }

  function defaultNodeBinary() {
    const configured = String(getPref("codex.nodeBinaryPath", "") || "").trim();
    if (configured) return configured;
    const common = [
      "/usr/bin/node",
      "/usr/local/bin/node",
      "/opt/homebrew/bin/node",
      "/snap/bin/node",
    ];
    for (const p of common) {
      if (pathExists(p)) return p;
    }
    return "/usr/bin/node";
  }

  function writeTextFile(path, content, mode) {
    const file = nsFile(path);
    const fos = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
    // PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE
    fos.init(file, 0x02 | 0x08 | 0x20, mode || 0o755, 0);
    const cos = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
    cos.init(fos, "UTF-8");
    cos.writeString(content);
    cos.close();
  }

  function bridgeScriptPath() {
    const dir = guessWorkingDirectory();
    ensureDir(dir);
    return dir + "/codex-ws-bridge.js";
  }

  const addon = {
    id: ADDON_ID,
    ref: ADDON_REF,
    rootURI,
    appServerProcess: null,
    appServerPort: null,
    bridgeProcess: null,
    bridgePort: null,
    registeredPrefPane: false,
    registeredItemPaneSectionID: null,
    mainWindows: new Set(),
    registeredReaderListenerIDs: [],
    pendingExternalPrompts: [],
    hiddenSidebarPromptCount: 0,
    externalPromptDeliveryTimer: null,
    lastReaderPromptTarget: null,

    hooks: {
      onStartup: async (_data) => {
        addon.registerPreferencePane();
        addon.registerItemPaneSection();
        addon.registerReaderContextMenu();
        addon.addMenusToExistingWindows();
        try {
          Services.tm.dispatchToMainThread(() => {
            addon.addMenusToExistingWindows();
            for (const win of addon.mainWindows) addon.addSidebar(win);
          });
        } catch (_) {}
      },

      onShutdown: async () => {
        for (const win of addon.mainWindows) {
          try {
            addon.removeSidebar(win);
            addon.removeMenu(win);
          } catch (_) {}
        }
        addon.mainWindows.clear();
        addon.unregisterReaderContextMenu();
        addon.unregisterItemPaneSection();
        addon.stopCodexBridge();
        addon.stopCodexAppServer();
        try {
          delete Zotero.ZoteroCodexChat;
        } catch (_) {}
      },

      onMainWindowLoad: async (window) => {
        addon.mainWindows.add(window);
        addon.addMenu(window);
        addon.addSidebar(window);
      },

      onMainWindowUnload: async (window) => {
        addon.removeSidebar(window);
        addon.removeMenu(window);
        addon.mainWindows.delete(window);
      },

      onPrefsEvent: async (_type, _data) => {},
    },

    registerPreferencePane() {
      if (this.registeredPrefPane) return;
      try {
        if (Zotero.PreferencePanes?.register) {
          Zotero.PreferencePanes.register({
            pluginID: ADDON_ID,
            src: rootURI + "content/preferences.xhtml",
            label: "Codex Chat",
          });
          this.registeredPrefPane = true;
        }
      } catch (e) {
        log(`Preference pane registration failed: ${e}`, "error");
      }
    },



    registerReaderContextMenu() {
      if (this.registeredReaderListenerIDs.length) return;
      const readerAPI = Zotero.Reader;
      if (!readerAPI?.registerEventListener) {
        log("Zotero.Reader.registerEventListener is unavailable; PDF Reader Ask Codex context menu was not registered.", "error");
        return;
      }

      const handler = (eventOrParams, maybeParams) => {
        try {
          const event = maybeParams || eventOrParams || {};
          const params = event.params || event || {};
          const reader = event.reader || params.reader || null;
          const append = event.append;
          if (typeof append !== "function") return;

          append({
            label: "Ask Codex",
            onCommand: () => {
              const win = reader?._iframeWindow || reader?._iframe?.contentWindow || null;
              const selectedText = this.extractReaderSelectedText({ ...params, reader }, win);
              this.askCodexAboutReaderSelection(selectedText, { ...params, reader });
            },
          });
        } catch (e) {
          log(`Reader context menu handler failed: ${e}`, "error");
        }
      };

      const selectionPopupHandler = (event) => {
        try {
          const reader = event.reader || null;
          const doc = event.doc || reader?._iframeWindow?.document || null;
          const params = event.params || {};
          const append = event.append;
          if (!doc || typeof append !== "function") return;
          const win = reader?._iframeWindow || reader?._iframe?.contentWindow || null;
          const capturedText = this.extractReaderSelectedText({ ...params, reader }, win);

          const button = doc.createElement("button");
          button.type = "button";
          button.textContent = "Ask Codex";
          button.title = "Ask Codex about the selected PDF text";
          button.style.cssText = [
            "margin-left:6px",
            "padding:4px 8px",
            "border:1px solid rgba(0,0,0,.25)",
            "border-radius:4px",
            "background:#fff",
            "color:#111",
            "font:12px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
            "cursor:pointer",
          ].join(";");
          button.addEventListener("click", (ev) => {
            ev.preventDefault?.();
            ev.stopPropagation?.();
            const selectedText = capturedText || this.extractReaderSelectedText({ ...params, reader }, win);
            this.askCodexAboutReaderSelection(selectedText, { ...params, reader });
          });
          append(button);
        } catch (e) {
          log(`Reader text selection popup handler failed: ${e}`, "error");
        }
      };

      const registerOne = (eventName) => {
        try {
          readerAPI.registerEventListener(eventName, handler, ADDON_ID);
          this.registeredReaderListenerIDs.push({ type: eventName, handler });
          return true;
        } catch (e) {
          log(`Reader listener ${eventName} registration failed: ${e}`, "error");
          return false;
        }
      };

      registerOne("createViewContextMenu");
      registerOne("createAnnotationContextMenu");
      registerOne("createSelectorContextMenu");
      try {
        readerAPI.registerEventListener("renderTextSelectionPopup", selectionPopupHandler, ADDON_ID);
        this.registeredReaderListenerIDs.push({ type: "renderTextSelectionPopup", handler: selectionPopupHandler });
      } catch (e) {
        log(`Reader listener renderTextSelectionPopup registration failed: ${e}`, "error");
      }
    },

    unregisterReaderContextMenu() {
      const readerAPI = Zotero.Reader;
      if (!readerAPI) return;
      try {
        readerAPI._unregisterEventListenerByPluginID?.(ADDON_ID);
      } catch (_) {}
      for (const entry of this.registeredReaderListenerIDs.splice(0)) {
        try {
          if (readerAPI.unregisterEventListener && entry?.type && entry?.handler) {
            readerAPI.unregisterEventListener(entry.type, entry.handler);
          } else if (readerAPI.unregisterEvent) {
            readerAPI.unregisterEvent(entry);
          }
        } catch (_) {}
      }
    },

    extractReaderSelectedText(params, win) {
      const readText = (value) => {
        try {
          if (!value) return "";
          if (typeof value === "string") return value;
          if (typeof value.text === "string") return value.text;
          if (typeof value.comment === "string") return value.comment;
          if (value.wrappedJSObject) return readText(value.wrappedJSObject);
          try {
            const waived = Components.utils.waiveXrays?.(value);
            if (waived && waived !== value) return readText(waived);
          } catch (_) {}
        } catch (_) {}
        return "";
      };
      const candidates = [
        () => readText(params?.annotation),
        () => readText(params?.params?.annotation),
        () => readText(params?.reader?._state?.primaryViewSelectionPopup?.annotation),
        () => readText(params?.reader?._state?.secondaryViewSelectionPopup?.annotation),
        () => params?.selectedText,
        () => params?.selectionText,
        () => params?.selection?.text,
        () => params?.selection?.toString?.(),
        () => params?.reader?._iframeWindow?.getSelection?.().toString?.(),
        () => params?.reader?._iframe?.contentWindow?.getSelection?.().toString?.(),
        () => win?.getSelection?.().toString?.(),
        () => this.getReaderContext()?.selectedText,
      ];
      for (const fn of candidates) {
        try {
          const text = String(fn() || "").trim();
          if (text) return text.slice(0, 12000);
        } catch (_) {}
      }
      return "";
    },

    askCodexAboutReaderSelection(text, params) {
      const clean = String(text || "").trim();
      const readerCtx = this.getReaderContext() || {};
      const item = readerCtx.item;
      this.lastReaderPromptTarget = item || null;
      if (!clean) {
        this.deliverPromptToChat(
          "不要调用 Zotero MCP。请只根据当前输入框中已有的 PDF 选中文本回答；如果没有看到选中文本，请提示我重新选择文本后再点 Ask Codex。",
          "Ask Codex from PDF selection"
        );
        return;
      }
      const page = readerCtx.pageLabel ? `第 ${readerCtx.pageLabel} 页` : "当前页";
      const title = item?.title ? `《${item.title}》` : "当前 PDF";
      const prompt = `不要调用 Zotero MCP，也不要读取全文、批注或全库。只根据下面这段已经提供的 PDF 选中文本回答。\n\n请解释这段文本，并说明它在论文中的作用。\n\n来源：${title}，${page}\n\n选中文本：\n${clean}`;
      this.deliverPromptToChat(prompt, `Ask Codex: ${clean.slice(0, 80)}${clean.length > 80 ? "…" : ""}`);
    },

    deliverPromptToChat(prompt, displayText) {
      const payload = { prompt, displayText, ts: Date.now() };
      this.pendingExternalPrompts.push(payload);
      for (const win of this.mainWindows) {
        try {
          this.addSidebar(win);
          this.updateSidebarHandle(win.document);
        } catch (_) {}
      }
      this.scheduleExternalPromptDelivery();
      return true;
    },

    scheduleExternalPromptDelivery() {
      if (this.externalPromptDeliveryTimer) return;
      this.externalPromptDeliveryTimer = setTimeout(() => {
        this.externalPromptDeliveryTimer = null;
        this.flushExternalPromptsToChat();
      }, 100);
    },

    flushExternalPromptsToChat() {
      if (!this.pendingExternalPrompts.length) return false;
      let delivered = false;
      for (const win of this.mainWindows) {
        try { this.addSidebar(win); } catch (_) {}
        const ids = [ITEM_PANE_IFRAME_ID, SIDEBAR_IFRAME_ID];
        for (const id of ids) {
          try {
            const frame = win.document?.getElementById?.(id);
            const api = frame?.contentWindow?.ZoteroCodexChatFrameAPI;
            if (api?.receiveExternalPrompt) {
              const queued = this.pendingExternalPrompts.splice(0);
              for (const payload of queued) api.receiveExternalPrompt(payload);
              const sidebar = win.document?.getElementById?.(SIDEBAR_ID);
              if (id === SIDEBAR_IFRAME_ID && sidebar?.style?.display === "none") {
                this.hiddenSidebarPromptCount += queued.length;
              }
              delivered = true;
              this.updateSidebarHandle(win.document);
              break;
            }
          } catch (_) {}
        }
        if (delivered) break;
      }
      return delivered;
    },

    updateSidebarHandle(doc) {
      const handle = doc?.querySelector?.(".zcc-sidebar-handle");
      if (!handle) return;
      const count = this.pendingExternalPrompts.length + this.hiddenSidebarPromptCount;
      handle.textContent = count ? `Codex (${count})` : "Codex";
      handle.setAttribute(
        "title",
        count
          ? `${count} queued Codex prompt${count > 1 ? "s" : ""}. Click to open.`
          : "Open Codex Chat Sidebar"
      );
    },

    drainExternalPrompts() {
      return this.pendingExternalPrompts.splice(0);
    },

    registerItemPaneSection() {
      if (this.registeredItemPaneSectionID) return;
      try {
        if (!Zotero.ItemPaneManager?.registerSection) {
          log("Zotero.ItemPaneManager.registerSection is unavailable; native item-pane section was not registered.", "error");
          return;
        }
        this.registeredItemPaneSectionID = Zotero.ItemPaneManager.registerSection({
          paneID: ITEM_PANE_ID,
          pluginID: ADDON_ID,
          header: {
            l10nID: "zotero-codex-chat-item-pane-header",
            icon: rootURI + "content/icons/icon48.png",
          },
          sidenav: {
            l10nID: "zotero-codex-chat-item-pane-header",
            icon: rootURI + "content/icons/icon48.png",
          },
          onRender: ({ body, item, editable, tabType }) => {
            try {
              if (!body || body.dataset?.zccMounted === "1") return;
              body.textContent = "";
              if (body.dataset) body.dataset.zccMounted = "1";
              body.style.padding = "0";
              body.style.margin = "0";
              body.style.minHeight = "560px";
              body.style.height = "min(72vh, 760px)";
              body.style.overflow = "hidden";

              const doc = body.ownerDocument;
              const htmlNS = "http://www.w3.org/1999/xhtml";
              const frame = doc.createElementNS(htmlNS, "iframe");
              frame.setAttribute("id", ITEM_PANE_IFRAME_ID);
              frame.setAttribute("title", "Zotero Codex Chat");
              frame.setAttribute(
                "src",
                "chrome://zotero-codex-chat/content/chat.xhtml?itemPane=1" +
                  (item?.key ? "&itemKey=" + encodeURIComponent(item.key) : "") +
                  (tabType ? "&tabType=" + encodeURIComponent(tabType) : "")
              );
              frame.style.width = "100%";
              frame.style.height = "100%";
              frame.style.border = "0";
              frame.style.display = "block";
              frame.style.background = "var(--material-background, #fff)";
              body.appendChild(frame);
            } catch (e) {
              log(`Item pane Codex render failed: ${e}`, "error");
            }
          },
        });
      } catch (e) {
        log(`Item pane section registration failed: ${e}`, "error");
      }
    },

    unregisterItemPaneSection() {
      if (!this.registeredItemPaneSectionID) return;
      try {
        Zotero.ItemPaneManager?.unregisterSection?.(this.registeredItemPaneSectionID);
      } catch (e) {
        log(`Item pane section unregister failed: ${e}`, "error");
      }
      this.registeredItemPaneSectionID = null;
    },

    notifyCodexPaneLocation(window) {
      try {
        const ps = Services.prompt;
        ps.alert(
          window || this.getMostRecentMainWindow(),
          "Zotero Codex Chat",
          "Codex Chat 已集成到右侧条目详情栏。选中一篇文献后，在右侧详情栏的侧边导航中点击 Codex 图标即可打开。"
        );
      } catch (_) {}
    },

    addMenusToExistingWindows() {
      try {
        if (Zotero.getMainWindows) {
          for (const win of Zotero.getMainWindows()) {
            this.mainWindows.add(win);
            this.addMenu(win);
          }
          return;
        }
      } catch (e) {
        log(`Zotero.getMainWindows failed: ${e}`, "error");
      }

      try {
        const enumerator = Services.wm.getEnumerator("navigator:browser");
        while (enumerator.hasMoreElements()) {
          const win = enumerator.getNext();
          this.mainWindows.add(win);
          this.addMenu(win);
        }
      } catch (e) {
        log(`Window enumeration failed: ${e}`, "error");
      }
    },

    addMenu(window) {
      if (!window || !window.document) return;
      const doc = window.document;
      if (doc.getElementById(MENU_ID)) return;

      const createXUL = (name) =>
        doc.createXULElement ? doc.createXULElement(name) : doc.createElement(name);

      const popup = this.findToolsMenuPopup(doc);
      if (!popup) {
        // Do not create a new top-level toolbar/menu entry. The sidebar itself is the UI.
        return;
      }

      const sep = createXUL("menuseparator");
      sep.setAttribute("id", SEP_ID);

      const item = createXUL("menuitem");
      item.setAttribute("id", MENU_ID);
      item.setAttribute("label", "Open Codex Chat Sidebar");
      item.setAttribute("tooltiptext", "Show or hide the embedded Codex Chat sidebar");
      item.addEventListener("command", () => addon.toggleSidebar(window));

      popup.appendChild(sep);
      popup.appendChild(item);
    },

    findToolsMenuPopup(doc) {
      return (
        doc.getElementById("menu_ToolsPopup") ||
        doc.getElementById("tools-menu-popup") ||
        doc.getElementById("toolsMenuPopup") ||
        doc.querySelector("menupopup#menu_ToolsPopup") ||
        doc.querySelector("menu#menu_Tools menupopup") ||
        doc.querySelector("menu[label='Tools'] menupopup") ||
        doc.querySelector("menu[label='工具'] menupopup")
      );
    },

    removeMenu(window) {
      if (!window || !window.document) return;
      const doc = window.document;
      const item = doc.getElementById(MENU_ID);
      const sep = doc.getElementById(SEP_ID);
      const fallback = doc.getElementById(FALLBACK_MENU_ID);
      if (item) item.remove();
      if (sep) sep.remove();
      if (fallback) fallback.remove();
    },

    addSidebar(window) {
      if (!window || !window.document) return;
      const doc = window.document;
      if (doc.getElementById(SIDEBAR_ID)) return;

      const htmlNS = "http://www.w3.org/1999/xhtml";
      const host = doc.body || doc.documentElement;
      if (!host) return;

      this.ensureSidebarStyle(doc);

      const sidebar = doc.createElementNS(htmlNS, "div");
      sidebar.setAttribute("id", SIDEBAR_ID);
      sidebar.setAttribute("class", "zcc-sidebar");
      sidebar.style.display = "none";
      sidebar.style.width = `${this.clampSidebarWidth(window, Number(getPref("ui.sidebarWidth", 360) || 360))}px`;

      const resizer = doc.createElementNS(htmlNS, "div");
      resizer.setAttribute("class", "zcc-sidebar-resizer");
      resizer.setAttribute("title", "Drag to resize Codex sidebar");
      resizer.addEventListener("mousedown", (event) => this.startSidebarResize(window, event));

      const header = doc.createElementNS(htmlNS, "div");
      header.setAttribute("class", "zcc-sidebar-header");
      const title = doc.createElementNS(htmlNS, "div");
      title.setAttribute("class", "zcc-sidebar-title");
      title.textContent = "Codex";
      const controls = doc.createElementNS(htmlNS, "div");
      controls.setAttribute("class", "zcc-sidebar-controls");
      const refresh = doc.createElementNS(htmlNS, "button");
      refresh.setAttribute("type", "button");
      refresh.textContent = "↻";
      refresh.setAttribute("title", "Reload Codex Chat");
      refresh.addEventListener("click", () => {
        const frame = doc.getElementById(SIDEBAR_IFRAME_ID);
        if (frame) frame.setAttribute("src", "chrome://zotero-codex-chat/content/chat.xhtml?sidebar=1&ts=" + Date.now());
      });
      const close = doc.createElementNS(htmlNS, "button");
      close.setAttribute("type", "button");
      close.textContent = "×";
      close.setAttribute("title", "Hide Codex Sidebar");
      close.addEventListener("click", () => addon.hideSidebar(window));
      controls.append(refresh, close);
      header.append(title, controls);

      const frame = doc.createElementNS(htmlNS, "iframe");
      frame.setAttribute("id", SIDEBAR_IFRAME_ID);
      frame.setAttribute("class", "zcc-sidebar-frame");
      frame.setAttribute("src", "chrome://zotero-codex-chat/content/chat.xhtml?sidebar=1");
      frame.addEventListener("load", () => this.scheduleExternalPromptDelivery());

      const handle = doc.createElementNS(htmlNS, "button");
      handle.setAttribute("type", "button");
      handle.setAttribute("class", "zcc-sidebar-handle");
      handle.textContent = "Codex";
      handle.addEventListener("click", () => addon.showSidebar(window));
      handle.style.display = sidebar.style.display === "none" ? "block" : "none";

      sidebar.append(resizer, header, frame);
      host.appendChild(sidebar);
      host.appendChild(handle);
      this.updateSidebarHandle(doc);
    },

    clampSidebarWidth(window, width) {
      const viewportWidth = Number(window?.innerWidth || 1280);
      const maxWidth = Math.max(320, Math.min(680, Math.floor(viewportWidth * 0.55)));
      return Math.max(280, Math.min(maxWidth, Number(width) || 360));
    },

    startSidebarResize(window, event) {
      event.preventDefault();
      const doc = window.document;
      const sidebar = doc.getElementById(SIDEBAR_ID);
      if (!sidebar) return;
      const onMove = (moveEvent) => {
        const nextWidth = this.clampSidebarWidth(window, window.innerWidth - moveEvent.clientX);
        sidebar.style.width = `${nextWidth}px`;
        setPref("ui.sidebarWidth", nextWidth);
      };
      const onUp = () => {
        doc.removeEventListener("mousemove", onMove, true);
        doc.removeEventListener("mouseup", onUp, true);
        doc.documentElement?.classList?.remove?.("zcc-resizing-sidebar");
      };
      doc.documentElement?.classList?.add?.("zcc-resizing-sidebar");
      doc.addEventListener("mousemove", onMove, true);
      doc.addEventListener("mouseup", onUp, true);
    },

    ensureSidebarStyle(doc) {
      if (doc.getElementById(SIDEBAR_STYLE_ID)) return;
      const htmlNS = "http://www.w3.org/1999/xhtml";
      const style = doc.createElementNS(htmlNS, "style");
      style.setAttribute("id", SIDEBAR_STYLE_ID);
      style.textContent = `
        #${SIDEBAR_ID}.zcc-sidebar {
          position: fixed;
          top: 0;
          right: 0;
          width: min(460px, 42vw);
          height: 100vh;
          display: flex;
          flex-direction: column;
          background: var(--material-background, #fff);
          border-left: 1px solid rgba(0,0,0,.18);
          box-shadow: -8px 0 24px rgba(0,0,0,.16);
          z-index: 2147483000;
        }
        #${SIDEBAR_ID} .zcc-sidebar-resizer {
          position: absolute;
          left: -5px;
          top: 0;
          width: 10px;
          height: 100%;
          cursor: col-resize;
          z-index: 1;
        }
        #${SIDEBAR_ID} .zcc-sidebar-resizer:hover {
          background: rgba(37, 99, 235, .16);
        }
        #${SIDEBAR_ID} .zcc-sidebar-header {
          height: 34px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 8px 0 12px;
          border-bottom: 1px solid rgba(0,0,0,.14);
          background: rgba(250,250,250,.96);
          font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #${SIDEBAR_ID} .zcc-sidebar-title { font-weight: 650; }
        #${SIDEBAR_ID} .zcc-sidebar-controls { display: flex; gap: 4px; }
        #${SIDEBAR_ID} button,
        .zcc-sidebar-handle {
          border: 1px solid rgba(0,0,0,.18);
          border-radius: 6px;
          background: #fff;
          color: #111;
          cursor: pointer;
          font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #${SIDEBAR_ID} button { min-width: 25px; height: 24px; padding: 0 6px; }
        #${SIDEBAR_ID} .zcc-sidebar-frame {
          width: 100%;
          height: calc(100vh - 34px);
          border: 0;
          flex: 1 1 auto;
          background: #fff;
        }
        .zcc-sidebar-handle {
          position: fixed;
          right: 0;
          top: 42%;
          z-index: 2147482999;
          writing-mode: vertical-rl;
          padding: 10px 5px;
          border-radius: 8px 0 0 8px;
          box-shadow: -4px 0 12px rgba(0,0,0,.12);
        }
        .zcc-resizing-sidebar, .zcc-resizing-sidebar * {
          cursor: col-resize !important;
          user-select: none !important;
        }
        @media (prefers-color-scheme: dark) {
          #${SIDEBAR_ID}.zcc-sidebar { background: #202124; border-left-color: rgba(255,255,255,.18); }
          #${SIDEBAR_ID} .zcc-sidebar-header { background: #25272b; border-bottom-color: rgba(255,255,255,.14); color: #f1f3f4; }
          #${SIDEBAR_ID} button, .zcc-sidebar-handle { background: #2b2f36; color: #f1f3f4; border-color: rgba(255,255,255,.18); }
          #${SIDEBAR_ID} .zcc-sidebar-frame { background: #181a1f; }
        }
      `;
      (doc.head || doc.documentElement).appendChild(style);
    },

    showSidebar(window) {
      this.addSidebar(window);
      const doc = window.document;
      const sidebar = doc.getElementById(SIDEBAR_ID);
      const handle = doc.querySelector(".zcc-sidebar-handle");
      if (sidebar) sidebar.style.display = "flex";
      if (handle) handle.style.display = "none";
      this.hiddenSidebarPromptCount = 0;
      setPref("ui.sidebarVisible", true);
      this.scheduleExternalPromptDelivery();
    },

    hideSidebar(window) {
      const doc = window.document;
      const sidebar = doc.getElementById(SIDEBAR_ID);
      const handle = doc.querySelector(".zcc-sidebar-handle");
      if (sidebar) sidebar.style.display = "none";
      if (handle) handle.style.display = "block";
      setPref("ui.sidebarVisible", false);
      this.updateSidebarHandle(doc);
    },

    toggleSidebar(window) {
      this.addSidebar(window);
      const sidebar = window.document.getElementById(SIDEBAR_ID);
      if (!sidebar || sidebar.style.display === "none") this.showSidebar(window);
      else this.hideSidebar(window);
    },

    removeSidebar(window) {
      if (!window || !window.document) return;
      const doc = window.document;
      const sidebar = doc.getElementById(SIDEBAR_ID);
      const style = doc.getElementById(SIDEBAR_STYLE_ID);
      const handle = doc.querySelector(".zcc-sidebar-handle");
      if (sidebar) sidebar.remove();
      if (handle) handle.remove();
      if (style) style.remove();
    },

    openChatWindow(parentWindow) {
      // Compatibility shim for older commands. The UI now lives in Zotero's native item pane.
      this.notifyCodexPaneLocation(parentWindow || this.getMostRecentMainWindow());
    },

    getSettings() {
      return {
        binaryPath: String(getPref("codex.binaryPath", "") || ""),
        nodeBinaryPath: defaultNodeBinary(),
        appServerPort: Number(getPref("codex.appServerPort", 45123) || 45123),
        bridgePort: Number(getPref("codex.bridgePort", 45133) || 45133),
        model: String(getPref("codex.model", "") || ""),
        cwd: guessWorkingDirectory(),
        configuredCwd: String(getPref("codex.cwd", "") || ""),
        extraArgs: String(getPref("codex.extraArgs", "") || ""),
        mcpPort: Number(getPref("mcp.port", 23120) || 23120),
        mcpServerName: String(getPref("mcp.serverName", "zotero") || "zotero"),
        includeSelectionContext: !!getPref("chat.includeSelectionContext", true),
        contextMode: String(getPref("chat.contextMode", "auto") || "auto"),
        systemInstruction: String(getPref("chat.systemInstruction", "") || ""),
        profileDir: getProfileDirPath(),
        homeDir: getHomeDirPath(),
      };
    },

    saveSettings(settings) {
      if (typeof settings.binaryPath === "string") setPref("codex.binaryPath", settings.binaryPath.trim());
      if (typeof settings.nodeBinaryPath === "string") setPref("codex.nodeBinaryPath", settings.nodeBinaryPath.trim());
      if (settings.appServerPort !== undefined) setPref("codex.appServerPort", Number(settings.appServerPort));
      if (settings.bridgePort !== undefined) setPref("codex.bridgePort", Number(settings.bridgePort));
      if (typeof settings.model === "string") setPref("codex.model", settings.model.trim());
      if (typeof settings.cwd === "string") setPref("codex.cwd", settings.cwd.trim());
      if (typeof settings.extraArgs === "string") setPref("codex.extraArgs", settings.extraArgs.trim());
      if (settings.mcpPort !== undefined) setPref("mcp.port", Number(settings.mcpPort));
      if (typeof settings.mcpServerName === "string") setPref("mcp.serverName", settings.mcpServerName.trim() || "zotero");
      if (settings.includeSelectionContext !== undefined) setPref("chat.includeSelectionContext", !!settings.includeSelectionContext);
      if (typeof settings.contextMode === "string") setPref("chat.contextMode", settings.contextMode || "auto");
      if (typeof settings.systemInstruction === "string") setPref("chat.systemInstruction", settings.systemInstruction);
      return this.getSettings();
    },

    getChatHistory() {
      const raw = String(getPref("chat.history", "") || "");
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        log(`Failed to parse chat history: ${e}`, "error");
        return [];
      }
    },

    saveChatHistory(items) {
      try {
        setPref("chat.history", JSON.stringify(Array.isArray(items) ? items : []));
        return true;
      } catch (e) {
        log(`Failed to save chat history: ${e}`, "error");
        return false;
      }
    },

    buildCodexMCPToml() {
      const s = this.getSettings();
      const serverName = (s.mcpServerName || "zotero").replace(/[^A-Za-z0-9_-]/g, "_");
      const url = `http://127.0.0.1:${s.mcpPort}/mcp`;
      return [
        `# Add this block to ~/.codex/config.toml`,
        `# It lets Codex use the Zotero MCP server provided by zotero-mcp-plugin.`,
        `[mcp_servers.${serverName}]`,
        `url = "${url}"`,
        `enabled = true`,
        `startup_timeout_sec = 10`,
        `tool_timeout_sec = 120`,
        `# Zotero Codex Chat asks before read and write MCP calls because Zotero MCP`,
        `# runs inside Zotero and heavy reads can freeze the UI.`,
        `default_tools_approval_mode = "prompt"`,
        ``,
        `# Emergency read-only mode, if needed:`,
        `# disabled_tools = ["write_note", "write_tag", "write_metadata", "write_item"]`,
      ].join("\n");
    },

    itemToContextObject(item) {
      if (!item) return null;
      try {
        return {
          key: item.key,
          id: item.id,
          itemType: item.itemType,
          title: item.getDisplayTitle?.() || item.getField?.("title") || "",
          creators: (item.getCreators?.() || [])
            .map((c) => c.lastName || c.name || "")
            .filter(Boolean)
            .join(", "),
          year: String(item.getField?.("date") || "").match(/\d{4}/)?.[0] || "",
          isAttachment: !!item.isAttachment?.(),
          isNote: !!item.isNote?.(),
          isAnnotation: !!item.isAnnotation?.(),
          parentKey: item.parentItemKey || "",
        };
      } catch (_) {
        return null;
      }
    },

    getCurrentZoteroContext() {
      const win = this.getMostRecentMainWindow();
      const result = {
        items: [],
        collection: null,
        selectedText: "",
        reader: null,
      };
      if (!win) return result;

      try {
        const pane = win.ZoteroPane;
        const selectedItems = pane?.getSelectedItems?.() || [];
        result.items = selectedItems
          .slice(0, 20)
          .map((item) => this.itemToContextObject(item))
          .filter(Boolean);

        const collection = pane?.getSelectedCollection?.();
        if (collection) {
          result.collection = {
            key: collection.key,
            id: collection.id,
            name: collection.name,
          };
        }
      } catch (e) {
        log(`getCurrentZoteroContext selection failed: ${e}`, "error");
      }

      try {
        const selectedText = win.getSelection?.().toString?.() || "";
        result.selectedText = selectedText.slice(0, 8000);
      } catch (_) {}

      result.reader = this.getReaderContext();
      return result;
    },

    getReaderContext() {
      const win = this.getMostRecentMainWindow();
      const result = {
        item: null,
        selectedText: "",
        pageLabel: "",
        tabID: "",
      };
      if (!win) return result;

      try {
        const selectedID = win.Zotero_Tabs?.selectedID || win.Zotero_Tabs?.selectedTab?.id || "";
        result.tabID = selectedID || "";
        let reader = null;
        try {
          reader = Zotero.Reader?.getByTabID?.(selectedID) || win.Zotero?.Reader?.getByTabID?.(selectedID);
        } catch (_) {}
        try {
          reader = reader || Zotero.Reader?.getActiveReader?.() || win.Zotero?.Reader?.getActiveReader?.();
        } catch (_) {}

        if (reader) {
          const itemID = reader.itemID || reader._itemID || reader.item?.id || null;
          const item = itemID ? Zotero.Items.get(itemID) : reader.item || null;
          result.item = this.itemToContextObject(item);
          try {
            result.pageLabel = String(
              reader._internalReader?._primaryView?._currentPageLabel ||
              reader._internalReader?._primaryView?._currentPageIndex ||
              reader._state?.pageIndex ||
              ""
            );
          } catch (_) {}
          const selectionSources = [
            () => reader._iframeWindow?.getSelection?.().toString?.(),
            () => reader._iframe?.contentWindow?.getSelection?.().toString?.(),
            () => reader._internalReader?._iframeWindow?.getSelection?.().toString?.(),
            () => win.getSelection?.().toString?.(),
          ];
          for (const getText of selectionSources) {
            try {
              const text = String(getText() || "").trim();
              if (text) {
                result.selectedText = text.slice(0, 12000);
                break;
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        log(`getReaderContext failed: ${e}`, "error");
      }
      return result;
    },



    getSelectedZoteroItem() {
      const win = this.getMostRecentMainWindow();
      if (!win) return null;
      try {
        const pane = win.ZoteroPane || win.Zotero?.getActiveZoteroPane?.();
        const selectedItems = pane?.getSelectedItems?.() || [];
        if (selectedItems.length) return selectedItems[0];
      } catch (e) {
        log(`getSelectedZoteroItem failed: ${e}`, "error");
      }
      return null;
    },

    getZoteroItemByHint(hint) {
      if (!hint) return null;
      try {
        if (Number(hint.id)) {
          const item = Zotero.Items.get(Number(hint.id));
          if (item) return item;
        }
      } catch (_) {}
      try {
        const key = String(hint.key || hint.itemKey || "").trim();
        if (key) {
          const libraryID = Number(hint.libraryID) || Zotero.Libraries.userLibraryID;
          let item = Zotero.Items.getByLibraryAndKey?.(libraryID, key);
          if (item) return item;
        }
      } catch (_) {}
      return null;
    },

    resolveTopLevelBibliographicItem(item) {
      try {
        if (!item) return null;

        const seen = new Set();
        for (let depth = 0; item && depth < 8; depth++) {
          const id = Number(item.id);
          if (!id || seen.has(id)) break;
          seen.add(id);

          const parentID = item.parentItemID || item.parentID || null;
          const isChild = !!(item.isAttachment?.() || item.isNote?.() || item.isAnnotation?.() || parentID);
          if (!isChild || !parentID) break;

          const parent = Zotero.Items.get(parentID);
          if (!parent) break;
          item = parent;
        }

        if (!item || !Number(item.id)) return null;
        if (item.isNote?.() || item.isAttachment?.() || item.isAnnotation?.()) return null;
        return item;
      } catch (e) {
        log(`resolveTopLevelBibliographicItem failed: ${e}`, "error");
        return null;
      }
    },

    resolvePrimaryNoteTargetItem(hint) {
      try {
        const hinted = this.resolveTopLevelBibliographicItem(this.getZoteroItemByHint(hint));
        if (hinted) return hinted;

        const lastReader = this.resolveTopLevelBibliographicItem(this.getZoteroItemByHint(this.lastReaderPromptTarget));
        if (lastReader) return lastReader;

        const selected = this.resolveTopLevelBibliographicItem(this.getSelectedZoteroItem());
        if (selected) return selected;

        const readerItem = this.resolveTopLevelBibliographicItem(this.getZoteroItemByHint(this.getReaderContext()?.item));
        if (readerItem) return readerItem;
        return null;
      } catch (e) {
        log(`resolvePrimaryNoteTargetItem failed: ${e}`, "error");
        return null;
      }
    },

    getPrimaryNoteTarget(hint) {
      const item = this.resolvePrimaryNoteTargetItem(hint);
      if (!item) return null;
      try {
        return {
          id: item.id,
          key: item.key,
          libraryID: item.libraryID,
          title: item.getDisplayTitle?.() || item.getField?.("title") || "Untitled",
          itemType: item.itemType || "item",
        };
      } catch (e) {
        log(`getPrimaryNoteTarget failed: ${e}`, "error");
        return null;
      }
    },

    escapeHTML(text) {
      return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    },

    markdownToZoteroNoteHTML(markdown) {
      const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
      const html = [];
      let para = [];
      let inList = false;

      const flushPara = () => {
        if (!para.length) return;
        html.push(`<p>${para.map((x) => this.escapeHTML(x)).join("<br/>")}</p>`);
        para = [];
      };
      const closeList = () => {
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
      };

      for (const raw of lines) {
        const line = raw.trimEnd();
        const trimmed = line.trim();
        if (!trimmed) {
          flushPara();
          closeList();
          continue;
        }
        const h = trimmed.match(/^(#{1,4})\s+(.+)$/);
        if (h) {
          flushPara();
          closeList();
          const level = Math.min(h[1].length + 1, 4);
          html.push(`<h${level}>${this.escapeHTML(h[2])}</h${level}>`);
          continue;
        }
        const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
        if (bullet) {
          flushPara();
          if (!inList) {
            html.push("<ul>");
            inList = true;
          }
          html.push(`<li>${this.escapeHTML(bullet[1])}</li>`);
          continue;
        }
        closeList();
        para.push(line);
      }
      flushPara();
      closeList();

      return `<div data-zotero-codex-chat="note">${html.join("\n")}</div>`;
    },

    async writeMarkdownNoteToSelectedItem(markdown, title, targetHint) {
      const parent = this.resolvePrimaryNoteTargetItem(targetHint);
      if (!parent) {
        return { ok: false, message: "No Zotero bibliographic item is selected. Select a parent item first." };
      }
      const content = String(markdown || "").trim();
      if (!content) {
        return { ok: false, message: "Note content is empty." };
      }
      try {
        const note = new Zotero.Item("note");
        note.libraryID = parent.libraryID || Zotero.Libraries.userLibraryID;
        const noteTitle = String(title || "Codex 阅读笔记").trim();
        const html = this.markdownToZoteroNoteHTML(`# ${noteTitle}\n\n${content}`);
        note.setNote(html);
        let id = await note.saveTx();
        id = Number(id || note.id);
        if (!id) throw new Error("Saved note did not return an item ID.");
        await Zotero.DB.executeTransaction(async () => {
          await Zotero.DB.queryAsync("UPDATE itemNotes SET parentItemID=? WHERE itemID=?", [parent.id, id]);
          await Zotero.DB.queryAsync("DELETE FROM collectionItems WHERE itemID=?", [id]);
        });
        try {
          await Zotero.Items.reload([id, parent.id], ["primaryData", "childItems"], true);
        } catch (reloadError) {
          log(`Reloading note parent relationship failed: ${reloadError}`, "error");
        }
        try {
          await Zotero.Notifier.trigger("modify", "item", [id, parent.id]);
        } catch (notifyError) {
          log(`Notifying note parent relationship failed: ${notifyError}`, "error");
        }
        const saved = await Zotero.Items.getAsync(id);
        try {
          const win = this.getMostRecentMainWindow();
          if (parent.id && win?.ZoteroPane?.selectItem) await win.ZoteroPane.selectItem(parent.id);
        } catch (selectError) {
          log(`Selecting parent item after note write failed: ${selectError}`, "error");
        }
        return {
          ok: true,
          id,
          key: saved?.key || note.key || "",
          parentID: parent.id,
          parentKey: parent.key,
          parentTitle: parent.getDisplayTitle?.() || parent.getField?.("title") || "Untitled",
          message: `Wrote note to ${parent.getDisplayTitle?.() || parent.key}`,
        };
      } catch (e) {
        log(`writeMarkdownNoteToSelectedItem failed: ${e}`, "error");
        return { ok: false, message: String(e?.message || e) };
      }
    },

    getContextMode() {
      const mode = String(getPref("chat.contextMode", "auto") || "auto");
      const allowed = new Set(["auto", "items", "collection", "reader", "library", "none"]);
      return allowed.has(mode) ? mode : "auto";
    },

    formatContextForPrompt(modeOverride) {
      const s = this.getSettings();
      if (!s.includeSelectionContext) return "";
      const mode = modeOverride || this.getContextMode();
      if (mode === "none") return "";

      const ctx = this.getCurrentZoteroContext();
      const parts = [];

      const addCollection = () => {
        if (ctx.collection) {
          parts.push(`当前 Zotero collection: ${ctx.collection.name} (key=${ctx.collection.key})`);
        }
      };
      const addItems = () => {
        if (ctx.items.length) {
          parts.push("当前选中的 Zotero 条目：");
          for (const item of ctx.items) {
            parts.push(`- ${item.title || "Untitled"} | key=${item.key} | type=${item.itemType || "unknown"}${item.creators ? ` | creators=${item.creators}` : ""}${item.year ? ` | year=${item.year}` : ""}${item.parentKey ? ` | parentKey=${item.parentKey}` : ""}`);
          }
        }
      };
      const addWindowSelection = () => {
        if (ctx.selectedText) {
          parts.push("当前窗口选中文本：");
          parts.push(ctx.selectedText);
        }
      };
      const addReader = () => {
        const reader = ctx.reader || {};
        if (reader.item) {
          const item = reader.item;
          parts.push(`当前 PDF Reader 条目: ${item.title || "Untitled"} | key=${item.key} | type=${item.itemType || "unknown"}${reader.pageLabel ? ` | page=${reader.pageLabel}` : ""}`);
        }
        if (reader.selectedText) {
          parts.push("当前 PDF Reader 选中文本：");
          parts.push(reader.selectedText);
        }
      };

      if (mode === "items") {
        addItems();
        addWindowSelection();
      } else if (mode === "collection") {
        addCollection();
        parts.push("上下文模式：当前 collection。优先围绕该 collection 进行检索、分组、综述和比较；必要时可调用 Zotero MCP 读取 collection 内条目。");
      } else if (mode === "reader") {
        addReader();
        if (!parts.length) parts.push("上下文模式：PDF Reader 选中文本。但当前没有检测到 reader 选区；请在 Zotero PDF Reader 中选中文本后再提问。");
      } else if (mode === "library") {
        parts.push("上下文模式：Zotero 全库。不要局限当前选中文献；优先使用 Zotero MCP search_library / semantic_search / get_collections 等工具进行全库检索。只读操作可静默执行，不要写入 Zotero，除非用户明确要求写入并经过确认。");
        addCollection();
        addItems();
      } else {
        // auto: prefer precise reader selected text, then normal Zotero selection.
        addReader();
        addCollection();
        addItems();
        if (!ctx.reader?.selectedText) addWindowSelection();
      }

      if (!parts.length) return "";
      return parts.join("\n");
    },

    getMostRecentMainWindow() {
      try {
        return Services.wm.getMostRecentWindow("navigator:browser");
      } catch (_) {
        return Array.from(this.mainWindows).at(-1) || null;
      }
    },

    getClientWebSocketURL() {
      const s = this.getSettings();
      return `ws://127.0.0.1:${s.bridgePort || 45133}/ws`;
    },

    isCodexBridgeRunning() {
      return !!this.bridgeProcess && this.bridgeProcess.isRunning;
    },

    startCodexBridge() {
      const settings = this.getSettings();
      if (this.isCodexBridgeRunning()) {
        return {
          ok: true,
          alreadyRunning: true,
          port: this.bridgePort || settings.bridgePort,
          message: "Codex WebSocket bridge is already running.",
        };
      }

      const nodePath = settings.nodeBinaryPath;
      let nodeFile;
      try {
        nodeFile = nsFile(nodePath);
      } catch (e) {
        return { ok: false, message: `Invalid Node binary path: ${e}` };
      }
      if (!nodeFile.exists()) return { ok: false, message: `Node binary does not exist: ${nodePath}` };
      if (!nodeFile.isExecutable()) return { ok: false, message: `Node binary is not executable: ${nodePath}` };

      let scriptPath;
      try {
        scriptPath = bridgeScriptPath();
        writeTextFile(scriptPath, BRIDGE_SCRIPT, 0o755);
      } catch (e) {
        return { ok: false, message: `Failed to write bridge script: ${e}` };
      }

      const bridgePort = Number(settings.bridgePort || 45133);
      const appServerPort = Number(settings.appServerPort || 45123);
      const args = [scriptPath, "--listen", String(bridgePort), "--codex-port", String(appServerPort)];
      try {
        const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
        process.init(nodeFile);
        process.runAsync(args, args.length, {
          observe: (subject, topic, data) => {
            log(`Codex bridge process event: ${topic} ${data || ""}`);
            if (topic === "process-finished" || topic === "process-failed") {
              if (addon.bridgeProcess === process) addon.bridgeProcess = null;
            }
          },
        });
        this.bridgeProcess = process;
        this.bridgePort = bridgePort;
        log(`started codex bridge: ${nodePath} ${args.join(" ")}`);
        return { ok: true, alreadyRunning: false, port: bridgePort, args, message: `Started Codex bridge on ws://127.0.0.1:${bridgePort}/ws` };
      } catch (e) {
        log(`startCodexBridge failed: ${e}`, "error");
        return { ok: false, message: String(e) };
      }
    },

    stopCodexBridge() {
      if (!this.bridgeProcess) return { ok: true, message: "Codex bridge is not running." };
      try {
        if (this.bridgeProcess.isRunning) this.bridgeProcess.kill();
        this.bridgeProcess = null;
        return { ok: true, message: "Codex bridge stopped." };
      } catch (e) {
        log(`stopCodexBridge failed: ${e}`, "error");
        return { ok: false, message: String(e) };
      }
    },

    isCodexAppServerRunning() {
      return !!this.appServerProcess && this.appServerProcess.isRunning;
    },

    startCodexAppServer() {
      const settings = this.getSettings();
      if (this.isCodexAppServerRunning()) {
        return {
          ok: true,
          alreadyRunning: true,
          port: this.appServerPort || settings.appServerPort,
          message: "Codex app-server is already running.",
        };
      }

      if (!settings.binaryPath) {
        return { ok: false, message: "Codex binary path is empty." };
      }

      let file;
      try {
        file = nsFile(settings.binaryPath);
      } catch (e) {
        return { ok: false, message: `Invalid Codex binary path: ${e}` };
      }

      if (!file.exists()) {
        return { ok: false, message: `Codex binary does not exist: ${settings.binaryPath}` };
      }
      if (!file.isExecutable()) {
        return { ok: false, message: `Codex binary is not executable: ${settings.binaryPath}` };
      }

      const port = Number(settings.appServerPort || 45123);
      const args = ["app-server", "--listen", `ws://127.0.0.1:${port}`];
      const extraArgs = this.parseExtraArgs(settings.extraArgs);
      if (extraArgs.length) args.push(...extraArgs);

      try {
        const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
        process.init(file);
        process.runAsync(args, args.length, {
          observe: (subject, topic, data) => {
            log(`Codex app-server process event: ${topic} ${data || ""}`);
            if (topic === "process-finished" || topic === "process-failed") {
              if (addon.appServerProcess === process) {
                addon.appServerProcess = null;
              }
            }
          },
        });
        this.appServerProcess = process;
        this.appServerPort = port;
        log(`started codex app-server: ${settings.binaryPath} ${args.join(" ")}`);
        return {
          ok: true,
          alreadyRunning: false,
          port,
          args,
          message: `Started Codex app-server on ws://127.0.0.1:${port}`,
        };
      } catch (e) {
        log(`startCodexAppServer failed: ${e}`, "error");
        return { ok: false, message: String(e) };
      }
    },

    stopCodexAppServer() {
      if (!this.appServerProcess) {
        return { ok: true, message: "Codex app-server is not running." };
      }
      try {
        if (this.appServerProcess.isRunning) {
          this.appServerProcess.kill();
        }
        this.appServerProcess = null;
        return { ok: true, message: "Codex app-server stopped." };
      } catch (e) {
        log(`stopCodexAppServer failed: ${e}`, "error");
        return { ok: false, message: String(e) };
      }
    },

    parseExtraArgs(text) {
      const input = String(text || "").trim();
      if (!input) return [];
      // Small shell-like splitter with quote support. This intentionally does not expand variables.
      const out = [];
      let cur = "";
      let quote = null;
      let escaping = false;
      for (const ch of input) {
        if (escaping) {
          cur += ch;
          escaping = false;
          continue;
        }
        if (ch === "\\") {
          escaping = true;
          continue;
        }
        if (quote) {
          if (ch === quote) quote = null;
          else cur += ch;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (/\s/.test(ch)) {
          if (cur) {
            out.push(cur);
            cur = "";
          }
          continue;
        }
        cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    },
  };

  Zotero.ZoteroCodexChat = addon;
})();
