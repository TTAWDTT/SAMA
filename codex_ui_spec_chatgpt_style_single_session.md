# Codex UI Spec v1 (Windows-only): ChatGPT-like Single-Session UI for Electron VRM Companion

> Feed this to Codex to **refactor and redesign** the existing project UI.  
> Goal: make **Chat + Sidebar** feel like ChatGPT-class UI (clean, minimal, readable), while keeping **single session** (no conversation list).  
> Scope: **renderer UI only** + minimal IPC wiring updates as needed.  
> Non-goals: new features beyond UI/UX; no new agent logic.

---

## 0) UX Decisions (MUST)

- **Single session only**:
  - No “New chat”
  - No conversation list
  - No session switching UI
- **Main view = Chat**
- **Left sidebar = Drawer** (collapsible), containing:
  1) LLM Config
  2) Actions / Motion
  3) Memory Viewer
  4) Developer Console (optional tab; default hidden behind toggle)

Sidebar is a **control center**, not a tool menu.

---

## 1) Visual Style Targets

### 1.1 General
- Minimal, neutral UI
- High readability, lots of whitespace
- Rounded corners (12px), subtle borders
- Soft shadows only for floating elements
- Smooth transitions (150–220ms)

### 1.2 Color tokens (CSS variables)
Implement in `:root` and `[data-theme="dark"]`:

- `--bg`, `--panel`, `--border`, `--text`, `--muted`, `--accent`
- Choose safe defaults:
  - Light: bg #ffffff, panel #f7f7f8, border #e5e7eb, text #111827, muted #6b7280
  - Dark: bg #0b0f19, panel #111827, border #1f2937, text #e5e7eb, muted #9ca3af
- Accent can be #10a37f-like (ChatGPT-ish), but don’t overuse.

### 1.3 Typography
- Use system font stack:
  - `"Inter", "Segoe UI", system-ui, -apple-system, sans-serif`
- Sizes:
  - Chat text: 14–15px
  - Secondary: 12–13px
  - Headings: 16–18px

---

## 2) IA / Layout

### 2.1 Window Layout (Chat Window)
Single window with:
- Top bar (title + status + sidebar toggle)
- Main chat timeline
- Composer at bottom
- Left drawer overlay (slides in)

```
┌──────────────────────────────────────────────┐
│ TopBar  [☰]   Companion   ● Connected   (⋯) │
├──────────────────────────────────────────────┤
│ ChatTimeline                                 │
│  - bubbles / blocks                          │
│  - markdown support                          │
│                                              │
├──────────────────────────────────────────────┤
│ Composer: [ + ]  input...           [Send]   │
└──────────────────────────────────────────────┘
```

### 2.2 Sidebar Drawer
- Width: 320px
- Slides from left
- Contains icon tabs vertically (or top row inside drawer):
  - **⚙ LLM**
  - **🎭 Actions**
  - **🧠 Memory**
  - **🪵 Console** (optional; behind a “Dev Mode” toggle)

No session list.

---

## 3) Component Spec (MUST Implement)

Assume renderer uses TS + Vite. Codex may choose React or keep plain TS/DOM:
- Prefer React if project already uses it; otherwise implement in vanilla with minimal dependency.
- If adding React: keep it local to chat window only.

### 3.1 TopBar
- Left: sidebar toggle button
- Center: “Companion” title (and optional short status)
- Right: connection indicator + menu
- Menu items:
  - Toggle theme (light/dark)
  - Toggle Dev Mode (shows Console tab)
  - Clear local UI logs (not memory DB)

### 3.2 ChatTimeline
- Virtualization optional (not required in MVP)
- Each message renders with:
  - role badge (You / Her)
  - timestamp (muted)
  - content (supports basic markdown: code blocks, inline code, links)
- Keep assistant messages slightly “panel” background; user messages slightly “accent tint”
- Auto-scroll to bottom on new message unless user scrolled up

### 3.3 Composer
- Multiline textarea (Shift+Enter newline, Enter send)
- Left quick actions:
  - attach button `+` (for future; disabled now)
- Right send button
- Small helper text:
  - “Enter 发送，Shift+Enter 换行”

### 3.4 Sidebar Tabs

#### (A) LLM Config Panel
Purpose: configure provider & “personality” knobs (NOT raw model parameters).

Fields:
- Provider: `openai | deepseek | aistudio` (dropdown)
- API Key: masked input (optional; or show “managed by env” text)
- Reply style (segmented):
  - concise / normal / talkative
- Proactivity (slider): quiet ←→ clingy
- Tone (segmented): gentle / playful / serious
- Save button
- “Apply without restart” if possible

IPC:
- `SET_LLM_CONFIG` event to main/core

#### (B) Actions / Motion Panel
Purpose: let user control interaction level.

Buttons:
- “靠近一点” -> emits `MANUAL_ACTION` APPROACH
- “离远一点” -> emits `MANUAL_ACTION` RETREAT
- “安静模式” toggle -> sets “quiet mode” flag in core
- Expression test row:
  - NEUTRAL / HAPPY / SAD / SHY / TIRED

IPC:
- `MANUAL_ACTION` event (action + expression)

#### (C) Memory Viewer Panel
Purpose: show “what she remembers” in a human way.

UI:
- Search box (local filter)
- List of memory cards:
  - title (auto)
  - short summary
  - when
  - confidence (as dots, not numbers)
- Actions per card:
  - “纠正” (opens small inline editor -> sends `MEMORY_CORRECT`)
  - “忘掉” (sends `MEMORY_DELETE`)

IPC:
- `GET_MEMORY_LIST`
- `MEMORY_CORRECT`
- `MEMORY_DELETE`

If core doesn’t support these yet:
- Codex must implement minimal read-only list using existing SQLite events table.

#### (D) Developer Console Panel (Dev Mode only)
Purpose: replace ugly console with in-app log viewer.

UI:
- level filter: info/warn/error
- search
- clear
- live tail toggle
Data source:
- main process forwards logs via IPC: `APP_LOG` messages.

---

## 4) IPC Contract Additions (Codex MUST Add)

Create shared types in existing `packages/shared` if available.

Events (renderer -> main):
- `SET_LLM_CONFIG` payload { provider, apiKey?, replyStyle, proactivity, tone }
- `MANUAL_ACTION` payload { action, expression? }
- `GET_MEMORY_LIST` payload { limit, query? }
- `MEMORY_CORRECT` payload { id, correctedText }
- `MEMORY_DELETE` payload { id }
- `OPEN_SIDEBAR_TAB` payload { tab: "llm"|"actions"|"memory"|"console" }

Events (main -> renderer):
- `MEMORY_LIST` payload { items: [{ id, ts, summary, title?, confidence? }] }
- `APP_LOG` payload { ts, level, message, scope? }
- `CONNECTION_STATUS` payload { connected: boolean, provider?: string }

Codex should implement a thin adapter in main that forwards to core where applicable.

---

## 5) File-Level Implementation Plan (Codex MUST Follow)

### 5.1 Create/Refactor renderer/chat into one coherent UI
- `apps/stage-desktop/src/renderer/chat/` becomes main UI root
- Add:
  - `components/TopBar.ts(x)`
  - `components/Sidebar.ts(x)`
  - `components/ChatTimeline.ts(x)`
  - `components/Composer.ts(x)`
  - `panels/LlmPanel.ts(x)`
  - `panels/ActionsPanel.ts(x)`
  - `panels/MemoryPanel.ts(x)`
  - `panels/ConsolePanel.ts(x)`
  - `styles/theme.css`

### 5.2 Replace “ugly console”
- Stop using raw `<pre>` dumps
- Use ConsolePanel with filtering + search
- Pipe logs:
  - In main, intercept `console.log/warn/error` and forward to renderer (Dev Mode only)

### 5.3 Chat rendering
- Use a small markdown renderer:
  - If React: `marked` + safe sanitize, or `react-markdown`
  - If vanilla: `marked` + DOMPurify
- Must support code blocks properly.

---

## 6) UX Microinteractions (Small but Important)

- Sidebar open/close anim
- Message appear anim (fade + slight slide)
- Send button disabled when empty
- “Typing…” indicator when waiting LLM
- Error toast when LLM call fails (top-right, auto dismiss)

---

## 7) Definition of Done (Manual)

1. Chat window visually matches modern chat apps (clean, aligned, readable)
2. Sidebar has 3 main tabs (LLM / Actions / Memory); Console appears only in Dev Mode
3. No session list; single timeline only
4. Logs are viewable in ConsolePanel (filter/search works)
5. LLM config changes persist (local storage ok) and are sent to main/core
6. Actions panel buttons cause visible effect (at least expression change / approach/retreat command)
7. Memory panel shows at least a list (read-only ok if core lacks full CRUD)

---

## END SPEC
