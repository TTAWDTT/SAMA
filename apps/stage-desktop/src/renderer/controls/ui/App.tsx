import type { ChatLogEntry, ChatLogMessage } from "@sama/shared";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { getApi, type StageDesktopApi } from "./api";
import { Toast } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { SidebarDrawer, type SidebarTab } from "./components/SidebarDrawer";
import { ChatTimeline } from "./components/ChatTimeline";
import { Composer } from "./components/Composer";
import type { UiMessage } from "./components/MessageRow";
import { useToast } from "./hooks/useToast";
import { ActionsPanel } from "./panels/ActionsPanel";
import { ConsolePanel, type AppLogItem } from "./panels/ConsolePanel";
import { LlmPanel } from "./panels/LlmPanel";
import { MemoryPanel } from "./panels/MemoryPanel";
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
    if (v === "llm" || v === "actions" || v === "memory" || v === "console") return v;
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

  const uiMessages: UiMessage[] = useMemo(() => {
    const msgs: UiMessage[] = entries.map((e) => ({ ...e, status: "sent" as const }));
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
  }, [entries, sendError]);

  async function sendMessage(text: string) {
    if (!api || typeof api.chatInvoke !== "function") {
      showToast("preload API 缺失：无法发送消息", { timeoutMs: 4200 });
      return;
    }

    const msg = String(text ?? "").trim();
    if (!msg) return;

    // If the user sends while scrolled up, we follow ChatGPT behavior: jump to bottom.
    jumpToBottom();
    setSendError(null);
    setIsThinking(true);
    setDraft("");
    try {
      localStorage.removeItem(LS_DRAFT);
    } catch {}
    try {
      await api.chatInvoke(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("请求失败", { timeoutMs: 2400 });
      setSendError({ message, retryText: msg });
      setIsThinking(false);
    }
  }

  const connection = useMemo(() => {
    const p = String(provider || "unknown");
    const connected = p !== "off" && p !== "preload missing";
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
      />

      <div className="chatShell">
        <ChatTimeline
          ref={timelineRef}
          api={api}
          messages={uiMessages}
          isThinking={isThinking}
          scrollLock={scrollLock}
          onJumpToBottom={jumpToBottom}
          onRetry={(text) => void sendMessage(text)}
          onToast={showToast}
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
        ) : (
          <ConsolePanel logs={logs} onClear={() => setLogs([])} />
        )}
      </SidebarDrawer>

      <Toast message={toast.message} visible={toast.visible} onDismiss={hideToast} />
    </div>
  );
}
