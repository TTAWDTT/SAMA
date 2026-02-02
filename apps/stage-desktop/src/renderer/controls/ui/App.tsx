import type { ChatLogEntry, ChatLogMessage } from "@sama/shared";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApi, type StageDesktopApi, type ToolInfo, type SkillInfo } from "./api";
import { Toast } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { SidebarDrawer, type SidebarTab } from "./components/SidebarDrawer";
import { ChatTimeline } from "./components/ChatTimeline";
import { Composer, type ImageAttachment, type ComposerMeta } from "./components/Composer";
import { SearchBar } from "./components/SearchBar";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { Onboarding, hasSeenOnboarding } from "./components/Onboarding";
import type { UiMessage, MessageImage } from "./components/MessageRow";
import { useToast } from "./hooks/useToast";
import { ActionsPanel } from "./panels/ActionsPanel";
import { ConsolePanel, type AppLogItem } from "./panels/ConsolePanel";
import { LlmPanel } from "./panels/LlmPanel";
import { MemoryPanel } from "./panels/MemoryPanel";
import { ThemePanel, loadAccent, loadFontSize, loadBackground, loadCustomBgImage, applyAccentColor, applyFontSize, applyBackground, type ThemeMode } from "./panels/ThemePanel";
import { scrollToBottom } from "./lib/utils";
import { loadMotionUiSettings } from "./lib/motionUi";

type Theme = "light" | "dark";

const LS_THEME_MODE = "sama.ui.themeMode.v1";
const LS_DEV = "sama.ui.devMode.v1";
const LS_TAB = "sama.ui.sidebarTab.v1";
const LS_DRAFT = "sama.ui.chatDraft.v1";

function loadDraft(): string {
  try {
    return String(localStorage.getItem(LS_DRAFT) ?? "");
  } catch {
    return "";
  }
}

function loadTheme(): Theme {
  try {
    const v = String(localStorage.getItem(LS_THEME_MODE) ?? "");
    if (v === "dark" || v === "light") return v;
    // Handle "system" mode
    if (v === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {}
  return "light";
}

function loadDevMode(): boolean {
  try {
    return localStorage.getItem(LS_DEV) === "1";
  } catch {
    return false;
  }
}

function loadTab(): SidebarTab {
  try {
    const v = String(localStorage.getItem(LS_TAB) ?? "");
    if (v === "llm" || v === "actions" || v === "memory" || v === "theme" || v === "console") return v;
  } catch {}
  return "llm";
}

export function App() {
  const api = useMemo(() => getApi(), []);
  const { toast, showToast, hideToast } = useToast();

  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [devMode, setDevMode] = useState(loadDevMode);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState<SidebarTab>(loadTab);

  const [entries, setEntries] = useState<ChatLogEntry[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [draft, setDraft] = useState<string>(loadDraft);
  const [scrollLock, setScrollLock] = useState(false);
  const [sendError, setSendError] = useState<null | { message: string; retryText: string }>(null);

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const [provider, setProvider] = useState<string>("unknown");

  const [logs, setLogs] = useState<AppLogItem[]>([]);

  // Selection Mode
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Available tools and skills for the composer
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);

  // ... (search code)

  const handleExportChat = useCallback(() => {
    setSelectionMode(true);
    showToast("请勾选要导出的消息", { timeoutMs: 2000 });
  }, [showToast]);

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleConfirmExport = useCallback(async () => {
    if (selectedIds.size === 0) {
      showToast("未选择任何消息", { timeoutMs: 1500 });
      return;
    }

    const selectedEntries = entries.filter((e) => selectedIds.has(e.id));
    if (selectedEntries.length === 0) return;

    showToast("正在生成图片...", { timeoutMs: 5000 });

    try {
      // Safer import for html2canvas (handles both default and named exports)
      const mod = await import("html2canvas");
      const html2canvas = mod.default || mod;
      
      // Create off-screen container
      const container = document.createElement("div");
      container.style.position = "absolute";
      container.style.left = "-9999px";
      container.style.top = "0";
      container.style.width = "600px"; // Fixed width for nice export
      container.style.background = theme === "dark" ? "#141413" : "#faf9f5";
      container.style.padding = "40px";
      container.style.fontFamily = "var(--font)";
      document.body.appendChild(container);

      // Render messages to HTML string (simple reconstruction)
      let html = `<div style="display: flex; flex-direction: column; gap: 16px;">`;
      selectedEntries.forEach((e) => {
        const isUser = e.role === "user";
        const align = isUser ? "flex-end" : "flex-start";
        const bg = isUser ? (theme === "dark" ? "#1e1e1d" : "#f5f4f0") : (theme === "dark" ? "#faf9f5" : "#ffffff"); // white/dark bubble
        const color = isUser ? "inherit" : (theme === "dark" ? "#141413" : "inherit"); // SAMA bubble text color fix
        // SAMA bubble in light mode is white bg, black text. In dark mode, white bg, black text looks good?
        // Wait, app logic: assistant bubble is var(--bubble-assistant) -> transparent/white.
        // Let's stick to simple readable colors.
        
        const bubbleStyle = `
          padding: 12px 16px; 
          border-radius: 12px; 
          background: ${isUser ? (theme === "dark" ? "#333" : "#eee") : (theme === "dark" ? "#ccc" : "#fff")}; 
          color: ${isUser ? (theme === "dark" ? "#fff" : "#000") : "#000"};
          max-width: 80%;
          line-height: 1.5;
          font-size: 14px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.05);
        `;
        
        html += `
          <div style="display: flex; justify-content: ${align};">
            <div style="${bubbleStyle}">
              ${e.content.replace(/\n/g, "<br/>")}
            </div>
          </div>
        `;
      });
      html += `</div>`;
      container.innerHTML = html;

      const canvas = await html2canvas(container, {
        backgroundColor: theme === "dark" ? "#141413" : "#faf9f5",
        scale: 2 // Retina
      });

      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `sama-chat-${Date.now()}.png`;
      a.click();

      document.body.removeChild(container);
      setSelectionMode(false);
      setSelectedIds(new Set());
      showToast("已导出图片", { timeoutMs: 2000 });
    } catch (err) {
      console.error(err);
      showToast("导出失败", { timeoutMs: 3000 });
    }
  }, [entries, selectedIds, theme, showToast]);

  // Debounce search query for performance
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);

  // Debounce search query for performance
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Keyboard shortcuts modal
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Onboarding
  const [onboardingOpen, setOnboardingOpen] = useState(() => !hasSeenOnboarding());

  // Initialize theme settings on mount
  useEffect(() => {
    const accent = loadAccent();
    const fontSize = loadFontSize();
    const background = loadBackground();
    const customBgImage = loadCustomBgImage();
    applyAccentColor(accent, theme === "dark");
    applyFontSize(fontSize);
    applyBackground(background, theme === "dark", customBgImage);
  }, []);

  // Re-apply accent and background when theme changes
  useEffect(() => {
    const accent = loadAccent();
    const background = loadBackground();
    const customBgImage = loadCustomBgImage();
    applyAccentColor(accent, theme === "dark");
    applyBackground(background, theme === "dark", customBgImage);
  }, [theme]);

  // Calculate search matches (uses debounced query for performance)
  const searchMatches = useMemo(() => {
    if (!debouncedSearchQuery.trim()) return [];
    const query = debouncedSearchQuery.toLowerCase();
    const matches: { index: number; id: string }[] = [];
    entries.forEach((entry, index) => {
      if (entry.content.toLowerCase().includes(query)) {
        matches.push({ index, id: entry.id });
      }
    });
    return matches;
  }, [entries, debouncedSearchQuery]);

  // Search navigation
  const goToMatch = useCallback((matchIndex: number) => {
    if (searchMatches.length === 0) return;
    const safeIndex = ((matchIndex % searchMatches.length) + searchMatches.length) % searchMatches.length;
    setCurrentMatch(safeIndex);
    const match = searchMatches[safeIndex];
    if (match) {
      // Scroll to the matched message
      const el = document.getElementById(`msg-${match.id}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("searchHighlight");
        setTimeout(() => el.classList.remove("searchHighlight"), 2000);
      }
    }
  }, [searchMatches]);

  const handlePrevMatch = useCallback(() => {
    goToMatch(currentMatch - 1);
  }, [currentMatch, goToMatch]);

  const handleNextMatch = useCallback(() => {
    goToMatch(currentMatch + 1);
  }, [currentMatch, goToMatch]);

  // Keyboard shortcut for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Apply stored motion settings once at startup so users don't have to reopen panels.
  useEffect(() => {
    if (!api || typeof api.sendPetControl !== "function") return;
    const motion = loadMotionUiSettings();
    try {
      api.sendPetControl({
        type: "PET_CONTROL",
        ts: Date.now(),
        action: "SET_VRMA_CONFIG",
        config: { speed: motion.vrma.speed, paused: motion.vrma.paused }
      } as any);
      api.sendPetControl({
        type: "PET_CONTROL",
        ts: Date.now(),
        action: "SET_IDLE_CONFIG",
        config: { enabled: motion.idle.enabled, strength: motion.idle.strength, speed: motion.idle.speed }
      } as any);
      api.sendPetControl({
        type: "PET_CONTROL",
        ts: Date.now(),
        action: "SET_WALK_CONFIG",
        config: { enabled: motion.walk.enabled, speed: motion.walk.speed, stride: motion.walk.stride }
      } as any);
    } catch {}
  }, [api]);

  // Theme + persistence
  useEffect(() => {
    try {
      localStorage.setItem(LS_THEME_MODE, theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_DEV, devMode ? "1" : "0");
    } catch {}
    // If dev mode is turned off while on Console, bounce to LLM.
    if (!devMode && tab === "console") setTab("llm");
  }, [devMode, tab]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_TAB, tab);
    } catch {}
  }, [tab]);

  // Draft persistence (debounced)
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        const v = String(draft ?? "");
        if (!v.trim()) {
          localStorage.removeItem(LS_DRAFT);
        } else {
          localStorage.setItem(LS_DRAFT, v);
        }
      } catch {}
    }, 500);
    return () => window.clearTimeout(t);
  }, [draft]);

  // Scrolling heuristic:
  // - scrollLock=true when the user scrolls up more than 120px from bottom
  // - when unlocked, auto-follow new messages
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - (el.scrollTop + el.clientHeight);
      const locked = gap > 120;
      stickToBottomRef.current = !locked;
      setScrollLock(locked);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    if (stickToBottomRef.current) scrollToBottom(el);
  }, [entries, sendError, isThinking]);

  const jumpToBottom = useCallback(() => {
    const el = timelineRef.current;
    if (el) scrollToBottom(el);
    setScrollLock(false);
    stickToBottomRef.current = true;
  }, []);

  // Track "open chat" so proactive ignore logic doesn't misfire.
  useEffect(() => {
    try {
      api?.sendUserInteraction?.({ type: "USER_INTERACTION", ts: Date.now(), event: "OPEN_CHAT" } as any);
    } catch {}
    const onUnload = () => {
      try {
        api?.sendUserInteraction?.({ type: "USER_INTERACTION", ts: Date.now(), event: "CLOSE_CHAT" } as any);
      } catch {}
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [api]);

  // App info (provider)
  const refreshProvider = useCallback(async () => {
    if (!api || typeof api.getAppInfo !== "function") {
      setProvider("preload missing");
      return;
    }
    try {
      const info = await api.getAppInfo();
      setProvider(String(info?.llmProvider ?? "unknown") || "unknown");
    } catch {
      setProvider("unknown");
    }
  }, [api]);

  useEffect(() => {
    void refreshProvider();
  }, [refreshProvider]);

  // Load available tools and skills
  useEffect(() => {
    if (!api) return;
    void (async () => {
      try {
        if (typeof (api as any).getAvailableTools === "function") {
          const result = await (api as any).getAvailableTools();
          if (result?.tools && Array.isArray(result.tools)) {
            setAvailableTools(result.tools);
          }
        }
      } catch {}
      try {
        if (typeof (api as any).getAvailableSkills === "function") {
          const result = await (api as any).getAvailableSkills();
          if (result?.skills && Array.isArray(result.skills)) {
            setAvailableSkills(result.skills);
          }
        }
      } catch {}
    })();
  }, [api]);

  // Chat log subscription
  useEffect(() => {
    if (!api) {
      showToast("preload API 缺失：无法同步聊天记录", { timeoutMs: 5200 });
      return;
    }

    // Always pull once to avoid any race with did-finish-load.
    void (async () => {
      try {
        const sync = await api.getChatLog?.();
        if (sync && sync.type === "CHAT_LOG_SYNC") {
          setEntries(Array.isArray((sync as any).entries) ? ((sync as any).entries as ChatLogEntry[]) : []);
        }
      } catch {}
    })();

    if (typeof api.onChatLog !== "function") return;
    const unsub = api.onChatLog((msg: ChatLogMessage) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "CHAT_LOG_SYNC") {
        setEntries(Array.isArray((msg as any).entries) ? ((msg as any).entries as ChatLogEntry[]) : []);
        return;
      }
      if (msg.type === "CHAT_LOG_APPEND") {
        const entry = (msg as any).entry as ChatLogEntry | undefined;
        if (!entry || typeof entry !== "object") return;
        if (typeof (entry as any).content !== "string") return;
        setEntries((prev) => {
          const next = [...prev, entry];
          // Keep the DOM manageable (UI only; canonical log lives in main/memory).
          return next.length > 500 ? next.slice(-420) : next;
        });
        if (entry.role === "assistant") {
          setIsThinking(false);
          setSendError(null);
        }
        return;
      }
    });
    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, [api, showToast]);

  // App logs subscription (Dev Console)
  useEffect(() => {
    if (!api || typeof api.onAppLog !== "function") return;

    const logBuffer = { current: [] as AppLogItem[] };
    let flushTimer: number | null = null;

    const flushLogs = () => {
      if (logBuffer.current.length === 0) {
        flushTimer = null;
        return;
      }
      const newItems = [...logBuffer.current];
      logBuffer.current = [];
      
      setLogs((prev) => {
        const next = [...prev, ...newItems];
        return next.length > 800 ? next.slice(-650) : next;
      });
      flushTimer = null;
    };

    const unsub = api.onAppLog((m: any) => {
      if (!m || typeof m !== "object") return;
      if (m.type !== "APP_LOG") return;
      const item: AppLogItem = {
        ts: Number(m.ts) || Date.now(),
        level: (m.level === "error" || m.level === "warn" || m.level === "info") ? m.level : "info",
        message: String(m.message ?? ""),
        scope: m.scope ? String(m.scope) : undefined
      };
      
      logBuffer.current.push(item);
      
      if (!flushTimer) {
        flushTimer = window.setTimeout(flushLogs, 160);
      }
    });

    return () => {
      try {
        if (flushTimer) clearTimeout(flushTimer);
        unsub?.();
      } catch {}
    };
  }, [api]);

  // State for pending images (user-attached images that haven't been sent yet)
  const [pendingImages, setPendingImages] = useState<Map<string, MessageImage[]>>(new Map());

  const uiMessages: UiMessage[] = useMemo(() => {
    const msgs: UiMessage[] = entries.map((e) => {
      const images = pendingImages.get(e.id);
      return { ...e, status: "sent" as const, images };
    });
    if (sendError) {
      msgs.push({
        id: `err_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
        ts: Date.now(),
        role: "assistant",
        content: "请求失败",
        status: "error",
        errorMessage: sendError.message,
        retryText: sendError.retryText
      });
    }
    return msgs;
  }, [entries, sendError, pendingImages]);

  const sendMessage = useCallback(async (text: string, images?: ImageAttachment[], meta?: ComposerMeta) => {
    if (!api || typeof api.chatInvoke !== "function") {
      showToast("preload API 缺失：无法发送消息", { timeoutMs: 4200 });
      return;
    }

    const msg = String(text ?? "").trim();
    const hasImages = images && images.length > 0;
    if (!msg && !hasImages) return;

    // If the user sends while scrolled up, we follow ChatGPT behavior: jump to bottom.
    jumpToBottom();
    setSendError(null);
    setIsThinking(true);
    setDraft("");
    try {
      localStorage.removeItem(LS_DRAFT);
    } catch {}

    // Construct message content - for now just describe images since backend doesn't support them
    let content = msg;
    if (hasImages && !msg) {
      content = `[发送了 ${images!.length} 张图片]`;
    } else if (hasImages) {
      content = `${msg}\n[附带 ${images!.length} 张图片]`;
    }

    try {
      // Pass meta (tools/skills) to the backend
      const payload = meta ? { message: content, meta } : content;
      await api.chatInvoke(payload);
      // Store image references for display (keyed by a temporary ID that will be replaced by actual message)
      // Note: In a full implementation, images would be sent to the backend
      if (hasImages) {
        // We'll add images to the most recent user message after it's appended
        const lastUserEntry = entries.filter((e) => e.role === "user").slice(-1)[0];
        if (lastUserEntry) {
          setPendingImages((prev) => {
            const next = new Map(prev);
            next.set(lastUserEntry.id, images!.map((img) => ({ dataUrl: img.dataUrl, name: img.name })));
            return next;
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("请求失败", { timeoutMs: 2400 });
      setSendError({ message, retryText: msg });
      setIsThinking(false);
    }
  }, [api, entries, jumpToBottom, showToast]);

  const handleOpenLlmSettings = useCallback(() => {
    setDrawerOpen(true);
    setTab("llm");
  }, []);
  
  const handleRetry = useCallback((text: string) => {
    void sendMessage(text);
  }, [sendMessage]);

  const connection = useMemo(() => {
    const p = String(provider || "unknown");
    const connected = p !== "off" && p !== "preload missing" && p !== "fallback";
    return { connected, provider: p };
  }, [provider]);

  return (
    <div className="appRoot" data-theme={theme}>
      <TopBar
        title="Companion"
        connection={connection}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        theme={theme}
        devMode={devMode}
        onToggleDevMode={() => setDevMode((v) => !v)}
        onClearUiLogs={() => setLogs([])}
        onToggleSearch={() => setSearchOpen((v) => !v)}
        onExportChat={handleExportChat}
      />

      <SearchBar
        isOpen={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          setSearchQuery("");
          setCurrentMatch(0);
        }}
        searchQuery={searchQuery}
        onSearchChange={(q) => {
          setSearchQuery(q);
          setCurrentMatch(0);
        }}
        matchCount={searchMatches.length}
        currentMatch={currentMatch}
        onPrevMatch={handlePrevMatch}
        onNextMatch={handleNextMatch}
      />

      <div className="chatShell">
        <ChatTimeline
          ref={timelineRef}
          api={api}
          llmProvider={provider}
          onOpenLlmSettings={handleOpenLlmSettings}
          messages={uiMessages}
          isThinking={isThinking}
          scrollLock={scrollLock}
          onJumpToBottom={jumpToBottom}
          onRetry={handleRetry}
          onToast={showToast}
          searchQuery={searchQuery}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
        />
        {!selectionMode ? (
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={sendMessage}
            busy={isThinking}
            availableTools={availableTools}
            availableSkills={availableSkills}
          />
        ) : (
          <div className="selectionBar">
            <div className="selectionCount">已选 {selectedIds.size} 条</div>
            <button className="btn btnSm" onClick={() => {
              setSelectionMode(false);
              setSelectedIds(new Set());
            }}>
              取消
            </button>
            <button className="btn btnSm btnPrimary" onClick={() => void handleConfirmExport()}>
              导出图片
            </button>
          </div>
        )}
      </div>

      <SidebarDrawer
        open={drawerOpen}
        tab={tab}
        devMode={devMode}
        onClose={() => setDrawerOpen(false)}
        onTabChange={(next) => setTab(next)}
      >
        {tab === "llm" ? (
          <LlmPanel api={api} onToast={showToast} onConfigSaved={refreshProvider} />
        ) : tab === "actions" ? (
          <ActionsPanel api={api as StageDesktopApi | null} onToast={showToast} />
        ) : tab === "memory" ? (
          <MemoryPanel api={api} onToast={showToast} />
        ) : tab === "theme" ? (
          <ThemePanel
            theme={theme}
            onThemeChange={(mode: ThemeMode) => {
              if (mode === "light" || mode === "dark") {
                setTheme(mode);
              }
            }}
            onToast={showToast}
          />
        ) : (
          <ConsolePanel logs={logs} onClear={() => setLogs([])} />
        )}
      </SidebarDrawer>

      <Toast message={toast.message} visible={toast.visible} onDismiss={hideToast} />

      <KeyboardShortcuts isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <Onboarding isOpen={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
    </div>
  );
}
