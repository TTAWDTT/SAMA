import type { ChatLogEntry, ChatLogMessage } from "@sama/shared";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApi, type StageDesktopApi } from "./api";
import { Toast } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { SidebarDrawer, type SidebarTab } from "./components/SidebarDrawer";
import { ChatTimeline } from "./components/ChatTimeline";
import { Composer, type ImageAttachment } from "./components/Composer";
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

const LS_THEME = "sama.ui.theme.v1";
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
    const v = String(localStorage.getItem(LS_THEME) ?? "");
    if (v === "dark" || v === "light") return v;
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

  // Search state
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
      localStorage.setItem(LS_THEME, theme);
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

  const jumpToBottom = () => {
    const el = timelineRef.current;
    if (el) scrollToBottom(el);
    setScrollLock(false);
    stickToBottomRef.current = true;
  };

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
  useEffect(() => {
    if (!api || typeof api.getAppInfo !== "function") {
      setProvider("preload missing");
      return;
    }
    void (async () => {
      try {
        const info = await api.getAppInfo?.();
        setProvider(String(info?.llmProvider ?? "unknown") || "unknown");
      } catch {
        setProvider("unknown");
      }
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
    const unsub = api.onAppLog((m: any) => {
      if (!m || typeof m !== "object") return;
      if (m.type !== "APP_LOG") return;
      const item: AppLogItem = {
        ts: Number(m.ts) || Date.now(),
        level: (m.level === "error" || m.level === "warn" || m.level === "info") ? m.level : "info",
        message: String(m.message ?? ""),
        scope: m.scope ? String(m.scope) : undefined
      };
      setLogs((prev) => {
        const next = [...prev, item];
        return next.length > 800 ? next.slice(-650) : next;
      });
    });
    return () => {
      try {
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

  async function sendMessage(text: string, images?: ImageAttachment[]) {
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
      await api.chatInvoke(content);
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
  }

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
          onOpenLlmSettings={() => {
            setDrawerOpen(true);
            setTab("llm");
          }}
          messages={uiMessages}
          isThinking={isThinking}
          scrollLock={scrollLock}
          onJumpToBottom={jumpToBottom}
          onRetry={(text) => void sendMessage(text)}
          onToast={showToast}
          searchQuery={searchQuery}
        />
        <Composer value={draft} onChange={setDraft} onSend={sendMessage} busy={isThinking} />
      </div>

      <SidebarDrawer
        open={drawerOpen}
        tab={tab}
        devMode={devMode}
        onClose={() => setDrawerOpen(false)}
        onTabChange={(next) => setTab(next)}
      >
        {tab === "llm" ? (
          <LlmPanel api={api} onToast={showToast} />
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
