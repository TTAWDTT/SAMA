# 前端实现文档

本文档详细描述 SAMA Stage Desktop 应用的前端架构和实现细节。

## 目录

1. [项目结构](#项目结构)
2. [核心组件架构](#核心组件架构)
3. [状态管理](#状态管理)
4. [主题系统](#主题系统)
5. [IPC 通信](#ipc-通信)
6. [自定义 Hooks](#自定义-hooks)
7. [样式系统](#样式系统)
8. [性能优化](#性能优化)

---

## 项目结构

```
src/renderer/controls/ui/
├── App.tsx                    # 主应用组件
├── api.ts                     # preload API 封装
├── components/                # UI 组件
│   ├── ChatTimeline.tsx       # 聊天时间线
│   ├── Composer.tsx           # 消息输入框
│   ├── DateSeparator.tsx      # 日期分隔符
│   ├── JumpToBottom.tsx       # 跳转到底部按钮
│   ├── KeyboardShortcuts.tsx  # 快捷键帮助
│   ├── MessageRow.tsx         # 消息行组件
│   ├── Onboarding.tsx         # 新手引导
│   ├── SearchBar.tsx          # 搜索栏
│   ├── SidebarDrawer.tsx      # 侧边栏抽屉
│   ├── Toast.tsx              # 提示消息
│   ├── TopBar.tsx             # 顶部导航栏
│   ├── VirtualList.tsx        # 虚拟滚动列表
│   └── VirtualChatTimeline.tsx# 虚拟化聊天时间线
├── panels/                    # 设置面板
│   ├── ActionsPanel.tsx       # 动作控制面板
│   ├── ConsolePanel.tsx       # 开发者控制台
│   ├── LlmPanel.tsx           # LLM 设置面板
│   ├── MemoryPanel.tsx        # 记忆管理面板
│   └── ThemePanel.tsx         # 主题设置面板
├── hooks/                     # 自定义 Hooks
│   ├── index.ts               # 导出入口
│   ├── useToast.ts            # 提示消息 Hook
│   ├── useSearch.ts           # 搜索功能 Hook
│   ├── useScrollLock.ts       # 滚动锁定 Hook
│   └── useThemeSettings.ts    # 主题设置 Hook
├── lib/                       # 工具库
│   ├── utils.ts               # 通用工具函数
│   ├── motionUi.ts            # 动画 UI 配置
│   ├── petControl.ts          # Pet 控制
│   ├── filePicker.ts          # 文件选择器
│   ├── stripMarkdown.ts       # Markdown 处理
│   ├── vrmaDb.ts              # VRMA 数据库
│   └── vrmaPresets.ts         # VRMA 预设
└── styles.css                 # 全局样式
```

---

## 核心组件架构

### App.tsx - 主应用组件

App 组件是整个 UI 的入口点，负责：

1. **状态管理**：管理主题、聊天记录、搜索、开发模式等全局状态
2. **IPC 通信**：通过 preload API 与主进程通信
3. **生命周期管理**：初始化和清理订阅

```typescript
export function App() {
  const api = useMemo(() => getApi(), []);
  const { toast, showToast, hideToast } = useToast();

  // 主题状态
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [devMode, setDevMode] = useState(loadDevMode);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState<SidebarTab>(loadTab);

  // 聊天状态
  const [entries, setEntries] = useState<ChatLogEntry[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [draft, setDraft] = useState<string>(loadDraft);

  // 搜索状态（带防抖）
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

  // ... 更多状态和逻辑
}
```

### ChatTimeline.tsx - 聊天时间线

聊天时间线组件负责渲染消息列表，支持：

- **消息分组显示**：同一分钟内的连续消息会被分组
- **搜索高亮**：匹配的关键词会被高亮显示
- **滚动锁定**：用户向上滚动时锁定，新消息不会自动滚动
- **日期分隔符**：不同日期的消息之间显示分隔符

```typescript
export const ChatTimeline = React.forwardRef<HTMLDivElement, ChatTimelineProps>(
  (props, ref) => {
    const {
      messages,
      isThinking,
      scrollLock,
      onJumpToBottom,
      onRetry,
      searchQuery,
      ...
    } = props;

    // 消息分组逻辑
    const getIsGroupStart = (msg: UiMessage, index: number) => {
      if (index === 0) return true;
      const prevMsg = messages[index - 1];
      if (!prevMsg) return true;
      if (prevMsg.role !== msg.role) return true;
      // 同一分钟内的消息分组
      if (Math.abs(msg.ts - prevMsg.ts) > 60000) return true;
      return false;
    };

    return (
      <div ref={ref} className="timeline">
        {messages.map((msg, i) => (
          <MessageRow
            key={msg.id}
            msg={msg}
            isGroupStart={getIsGroupStart(msg, i)}
            searchQuery={searchQuery}
            onCopy={handleCopy}
            onRetry={onRetry}
          />
        ))}
        {isThinking && <ThinkingIndicator />}
        {scrollLock && <JumpToBottom onClick={onJumpToBottom} />}
      </div>
    );
  }
);
```

### Composer.tsx - 消息输入组件

消息输入框支持：

- **多行输入**：自动调整高度
- **图片粘贴**：支持从剪贴板粘贴图片
- **快捷键发送**：Enter 发送，Shift+Enter 换行
- **草稿保存**：自动保存未发送的内容

```typescript
export function Composer(props: ComposerProps) {
  const { value, onChange, onSend, busy } = props;
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 处理粘贴事件（支持图片）
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        try {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            setImages(prev => [...prev, { dataUrl, name: file.name }]);
          };
          reader.readAsDataURL(file);
        } catch (err) {
          console.error("Failed to read image:", err);
        }
      }
    }
  };

  // 发送消息
  const handleSend = () => {
    if (busy) return;
    const text = value.trim();
    if (!text && images.length === 0) return;

    onSend(text, images.length > 0 ? images : undefined);
    setImages([]);
  };

  return (
    <div className="composerArea">
      <div className="composerBox">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          placeholder="输入消息..."
        />
        <button onClick={handleSend} disabled={busy}>
          发送
        </button>
      </div>
    </div>
  );
}
```

### MessageRow.tsx - 消息行组件

消息行组件负责渲染单条消息，支持：

- **角色区分**：用户消息和助手消息样式不同
- **代码高亮**：使用 highlight.js 渲染代码块
- **复制功能**：点击复制消息内容
- **重试功能**：失败消息可重试
- **搜索高亮**：匹配文本高亮显示

```typescript
export function MessageRow(props: MessageRowProps) {
  const { msg, isGroupStart, searchQuery, onCopy, onRetry } = props;

  // 高亮搜索关键词
  const highlightText = (text: string, query: string) => {
    if (!query) return text;
    const parts = text.split(new RegExp(`(${escapeRegex(query)})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase()
        ? <mark key={i}>{part}</mark>
        : part
    );
  };

  return (
    <div
      id={`msg-${msg.id}`}
      className={`msgRow ${msg.role} ${isGroupStart ? 'groupStart' : ''}`}
    >
      <div className="msgContent">
        {renderContent(msg.content, searchQuery)}
      </div>
      <div className="msgMeta">
        <span className="msgTime">{formatTime(msg.ts)}</span>
        <button onClick={() => onCopy(msg.content)}>复制</button>
        {msg.status === 'error' && (
          <button onClick={() => onRetry(msg.retryText)}>重试</button>
        )}
      </div>
    </div>
  );
}
```

---

## 状态管理

### localStorage 持久化

应用使用 localStorage 进行状态持久化：

```typescript
// 存储键定义
const LS_THEME_MODE = "sama.ui.themeMode.v1";
const LS_DEV = "sama.ui.devMode.v1";
const LS_TAB = "sama.ui.sidebarTab.v1";
const LS_DRAFT = "sama.ui.chatDraft.v1";
const LS_ACCENT = "sama.ui.accent.v1";
const LS_FONT_SIZE = "sama.ui.fontSize.v1";
const LS_BACKGROUND = "sama.ui.background.v1";

// 加载函数示例
function loadTheme(): Theme {
  try {
    const v = String(localStorage.getItem(LS_THEME_MODE) ?? "");
    if (v === "dark" || v === "light") return v;
    if (v === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
  } catch {}
  return "light";
}
```

### 草稿防抖保存

草稿使用防抖保存，避免频繁写入：

```typescript
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
  }, 500); // 500ms 防抖
  return () => window.clearTimeout(t);
}, [draft]);
```

---

## 主题系统

### 主题模式

支持三种主题模式：

1. **light** - 浅色模式
2. **dark** - 深色模式
3. **system** - 跟随系统

```typescript
export type ThemeMode = "light" | "dark" | "system";

// 监听系统主题变化
useEffect(() => {
  if (themeMode !== "system") return;
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent) => {
    onThemeChange(e.matches ? "dark" : "light");
  };
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}, [themeMode, onThemeChange]);
```

### 主题色配置

预设了 6 种主题色：

```typescript
const ACCENT_PRESETS: ThemePreset[] = [
  { id: "green", name: "绿色", light: "#10a37f", dark: "#19c37d" },
  { id: "blue", name: "蓝色", light: "#3b82f6", dark: "#60a5fa" },
  { id: "purple", name: "紫色", light: "#8b5cf6", dark: "#a78bfa" },
  { id: "orange", name: "橙色", light: "#f59e0b", dark: "#fbbf24" },
  { id: "pink", name: "粉色", light: "#ec4899", dark: "#f472b6" },
  { id: "red", name: "红色", light: "#ef4444", dark: "#f87171" }
];
```

### 背景配置

支持纯色、渐变和自定义图片背景：

```typescript
const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { id: "default", name: "默认", type: "solid", value: "#ededed", darkValue: "#111111" },
  { id: "warm", name: "温暖", type: "solid", value: "#fef3c7", darkValue: "#1c1917" },
  { id: "sunset", name: "日落", type: "gradient",
    value: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)",
    darkValue: "linear-gradient(135deg, #1f1c2c 0%, #3a1c71 100%)"
  },
  // ...
];

// 应用背景
export function applyBackground(bgId: string, isDark: boolean, customImage?: string | null) {
  const root = document.documentElement;

  if (bgId === "custom" && customImage) {
    const overlayColor = isDark ? "rgba(0, 0, 0, 0.6)" : "rgba(255, 255, 255, 0.7)";
    const bgValue = `linear-gradient(${overlayColor}, ${overlayColor}), url("${customImage}") center/cover fixed`;
    root.style.setProperty("--chat-bg", bgValue);
    return;
  }

  const preset = BACKGROUND_PRESETS.find((p) => p.id === bgId);
  const value = isDark && preset?.darkValue ? preset.darkValue : preset?.value;
  root.style.setProperty("--chat-bg", value || "#ededed");
}
```

---

## IPC 通信

### API 封装

通过 preload 脚本暴露的 API 与主进程通信：

```typescript
// api.ts
export type StageDesktopApi = {
  // 获取应用信息
  getAppInfo: () => Promise<{ llmProvider: string }>;

  // 聊天功能
  chatInvoke: (message: string) => Promise<void>;
  getChatLog: () => Promise<ChatLogMessage>;
  onChatLog: (callback: (msg: ChatLogMessage) => void) => () => void;

  // Pet 控制
  sendPetControl: (cmd: any) => void;

  // 用户交互
  sendUserInteraction: (interaction: any) => void;

  // 日志
  onAppLog: (callback: (log: any) => void) => () => void;

  // LLM 设置
  getLlmConfig: () => Promise<LLMConfig>;
  setLlmConfig: (config: LLMConfig) => Promise<void>;

  // 记忆管理
  getMemoryStats: () => Promise<MemoryStats>;
  listMemoryFacts: (limit: number) => Promise<MemoryFact[]>;
  listMemoryNotes: (limit: number) => Promise<MemoryNote[]>;
  // ...
};

export function getApi(): StageDesktopApi | null {
  return (window as any).stageDesktopApi ?? null;
}
```

### 聊天日志订阅

```typescript
useEffect(() => {
  if (!api) return;

  // 初始同步
  void (async () => {
    const sync = await api.getChatLog?.();
    if (sync?.type === "CHAT_LOG_SYNC") {
      setEntries(sync.entries);
    }
  })();

  // 订阅实时更新
  const unsub = api.onChatLog((msg) => {
    if (msg.type === "CHAT_LOG_SYNC") {
      setEntries(msg.entries);
    } else if (msg.type === "CHAT_LOG_APPEND") {
      setEntries(prev => {
        const next = [...prev, msg.entry];
        // 限制 UI 显示数量
        return next.length > 500 ? next.slice(-420) : next;
      });
    }
  });

  return () => unsub?.();
}, [api]);
```

---

## 自定义 Hooks

### useToast - 提示消息

```typescript
export function useToast() {
  const [toast, setToast] = useState({ message: "", visible: false });
  const timerRef = useRef<number>();

  const showToast = useCallback((message: string, opts?: { timeoutMs?: number }) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, visible: true });
    timerRef.current = window.setTimeout(() => {
      setToast(prev => ({ ...prev, visible: false }));
    }, opts?.timeoutMs ?? 3000);
  }, []);

  const hideToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(prev => ({ ...prev, visible: false }));
  }, []);

  return { toast, showToast, hideToast };
}
```

### useSearch - 搜索功能

```typescript
export function useSearch<T extends { id: string; content: string }>(
  items: T[],
  options: UseSearchOptions = {}
): UseSearchResult {
  const { debounceMs = 150 } = options;

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);

  // 防抖处理
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  // 计算匹配结果
  const matches = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    const q = debouncedQuery.toLowerCase();
    return items
      .map((item, index) => ({ index, id: item.id }))
      .filter((_, i) => items[i].content.toLowerCase().includes(q));
  }, [items, debouncedQuery]);

  // 导航到指定匹配
  const goToMatch = useCallback((index: number) => {
    if (matches.length === 0) return;
    const safeIndex = ((index % matches.length) + matches.length) % matches.length;
    setCurrentMatch(safeIndex);

    const match = matches[safeIndex];
    const el = document.getElementById(`msg-${match.id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("searchHighlight");
      setTimeout(() => el.classList.remove("searchHighlight"), 2000);
    }
  }, [matches]);

  return {
    isOpen,
    open: () => setIsOpen(true),
    close: () => { setIsOpen(false); setQuery(""); setCurrentMatch(0); },
    query,
    setQuery: (q) => { setQuery(q); setCurrentMatch(0); },
    matches,
    currentMatch,
    goToNext: () => goToMatch(currentMatch + 1),
    goToPrev: () => goToMatch(currentMatch - 1),
  };
}
```

### useScrollLock - 滚动锁定

```typescript
export function useScrollLock(
  ref: React.RefObject<HTMLDivElement | null>,
  deps: React.DependencyList = []
): UseScrollLockResult {
  const [scrollLock, setScrollLock] = useState(false);
  const stickToBottomRef = useRef(true);

  // 监听滚动
  useEffect(() => {
    const el = ref.current;
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
  }, [ref]);

  // 依赖变化时自动滚动
  useEffect(() => {
    const el = ref.current;
    if (el && stickToBottomRef.current) {
      scrollToBottom(el);
    }
  }, deps);

  const jumpToBottom = useCallback(() => {
    const el = ref.current;
    if (el) scrollToBottom(el);
    setScrollLock(false);
    stickToBottomRef.current = true;
  }, [ref]);

  return { scrollLock, jumpToBottom };
}
```

---

## 样式系统

### CSS 变量

使用 CSS 变量实现主题切换：

```css
:root {
  /* 主题色 */
  --accent: #10a37f;
  --accent-hover: #0d8a6a;
  --accent-light: rgba(16, 163, 127, 0.1);

  /* 背景 */
  --chat-bg: #ededed;
  --card-bg: #ffffff;
  --card-border: #e5e5e5;

  /* 文字 */
  --text-primary: #1a1a1a;
  --text-secondary: #666666;
  --text-muted: #999999;
}

[data-theme="dark"] {
  --chat-bg: #111111;
  --card-bg: #1e1e1e;
  --card-border: #2e2e2e;
  --text-primary: #f0f0f0;
  --text-secondary: #a0a0a0;
  --text-muted: #666666;
}
```

### 响应式布局

```css
/* 侧边栏抽屉 */
.sidebarDrawer {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 360px;
  max-width: 90vw;
  transform: translateX(100%);
  transition: transform 0.3s ease;
}

.sidebarDrawer.open {
  transform: translateX(0);
}

/* 移动端适配 */
@media (max-width: 480px) {
  .sidebarDrawer {
    width: 100vw;
  }

  .composerArea {
    padding: 6px 8px;
  }
}
```

---

## 性能优化

### 虚拟滚动

对于长消息列表，使用虚拟滚动提升性能：

```typescript
export function VirtualList<T>({
  items,
  renderItem,
  estimatedItemHeight = 60,
  overscan = 3
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [itemHeights, setItemHeights] = useState<Map<number, number>>(new Map());

  // 计算可见范围
  const visibleRange = useMemo(() => {
    let startIndex = 0;
    let currentHeight = 0;

    for (let i = 0; i < items.length; i++) {
      const height = itemHeights.get(i) ?? estimatedItemHeight;
      if (currentHeight + height > scrollTop) {
        startIndex = i;
        break;
      }
      currentHeight += height;
    }

    let endIndex = startIndex;
    currentHeight = 0;
    for (let i = startIndex; i < items.length; i++) {
      const height = itemHeights.get(i) ?? estimatedItemHeight;
      currentHeight += height;
      endIndex = i;
      if (currentHeight > containerHeight) break;
    }

    return {
      start: Math.max(0, startIndex - overscan),
      end: Math.min(items.length - 1, endIndex + overscan)
    };
  }, [items, scrollTop, containerHeight, itemHeights, estimatedItemHeight, overscan]);

  // 渲染可见项
  return (
    <div ref={containerRef} onScroll={handleScroll}>
      <div style={{ height: totalHeight }}>
        {items.slice(visibleRange.start, visibleRange.end + 1).map((item, i) => (
          <VirtualItem
            key={visibleRange.start + i}
            index={visibleRange.start + i}
            onHeightChange={handleHeightChange}
          >
            {renderItem(item, visibleRange.start + i)}
          </VirtualItem>
        ))}
      </div>
    </div>
  );
}
```

### React.memo 优化

对于纯展示组件使用 React.memo：

```typescript
export const DateSeparator = React.memo(function DateSeparator({ date }: { date: string }) {
  return (
    <div className="dateSeparator">
      <span className="dateSeparatorText">{date}</span>
    </div>
  );
});

export const JumpToBottom = React.memo(function JumpToBottom({ onClick }: { onClick: () => void }) {
  return (
    <button className="jumpToBottom" onClick={onClick} aria-label="跳转到底部">
      ↓ 新消息
    </button>
  );
});
```

### 搜索防抖

搜索查询使用 150ms 防抖：

```typescript
useEffect(() => {
  const timer = setTimeout(() => {
    setDebouncedSearchQuery(searchQuery);
  }, 150);
  return () => clearTimeout(timer);
}, [searchQuery]);

// 使用防抖后的查询进行匹配计算
const searchMatches = useMemo(() => {
  if (!debouncedSearchQuery.trim()) return [];
  // 计算匹配...
}, [entries, debouncedSearchQuery]);
```

---

## 无障碍支持

### ARIA 属性

```typescript
// 消息区域
<div
  className="timeline"
  role="log"
  aria-label="聊天消息"
  aria-busy={isThinking}
>
  {/* 消息列表 */}
</div>

// 搜索框
<input
  type="text"
  role="searchbox"
  aria-label="搜索消息"
  aria-describedby="search-results"
/>
<span id="search-results" aria-live="polite">
  {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : "无匹配"}
</span>
```

### 键盘导航

```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    // Ctrl+F 打开搜索
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      setSearchOpen(true);
    }
    // Ctrl+K 打开快捷键帮助
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      setShortcutsOpen(v => !v);
    }
    // Escape 关闭模态框
    if (e.key === "Escape") {
      setSearchOpen(false);
      setShortcutsOpen(false);
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}, []);
```

---

## 总结

SAMA Stage Desktop 的前端采用了现代 React 开发最佳实践：

1. **组件化架构**：清晰的组件职责划分
2. **状态管理**：合理使用 useState/useEffect/useMemo
3. **性能优化**：虚拟滚动、React.memo、防抖
4. **可维护性**：自定义 Hooks 封装复用逻辑
5. **用户体验**：主题定制、无障碍支持、响应式设计
6. **类型安全**：完整的 TypeScript 类型定义
