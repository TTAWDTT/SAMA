# Codex Implementation Spec v1: ChatGPT-like Chat Composer + Message Rendering (Electron Renderer)

> Purpose: Give Codex a **focused, implementation-level** spec for the chat UI:  
> - **Composer** (input box, send behavior, keyboard shortcuts)  
> - **Timeline rendering** (message layout, markdown, code blocks, copy)  
> - **Scrolling + streaming** (typing indicator, partial tokens)  
> Platform: Windows-only Electron renderer (Vite + TS).  
> Scope: Renderer UI + minimal IPC hooks. No new agent logic.

---

## 0) Constraints & UX Rules (MUST)

1. **Single session**: one continuous timeline.
2. **Chat UI must be “boringly good”**:
   - readable
   - consistent spacing
   - good code blocks
   - good scrolling behavior
3. **No heavy frameworks requirement**:
   - If project already uses React, implement in React.
   - If not, implement using vanilla TS + DOM.
4. **Markdown rendering is required** for assistant messages:
   - headings, lists, links, inline code, code blocks
   - safe sanitization to prevent XSS

---

## 1) Data Model (Renderer)

Create minimal types in `packages/shared` or local `types.ts`.

```ts
export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;             // uuid
  role: ChatRole;
  ts: number;             // epoch ms
  content: string;        // markdown supported
  status?: "sending" | "sent" | "error" | "streaming";
};
```

Renderer maintains:
- `messages: ChatMessage[]`
- `isStreaming: boolean`
- `draft: string`
- `scrollLock: boolean` (true if user scrolled up)

---

## 2) Layout Spec (Chat Window)

### 2.1 Structure

```
ChatRoot
 ├─ TopBar (already spec’d elsewhere)
 ├─ Timeline (scroll container)
 │   ├─ MessageRow (user)
 │   ├─ MessageRow (assistant)
 │   └─ TypingIndicator (optional)
 └─ Composer (fixed bottom)
```

### 2.2 Spacing
- Timeline padding: 16px 16px 24px
- Max content width: 780px (centered), but fluid if window small
- Message vertical gap: 12px
- Bubble padding: 10px 12px

---

## 3) Message Rendering (ChatGPT-like)

### 3.1 Alignment Rules
- **User messages**: right aligned
- **Assistant messages**: left aligned

### 3.2 Visual Tokens
Use CSS variables from existing theme:
- user bubble: `background: color-mix(in srgb, var(--accent) 10%, var(--bg))`
- assistant bubble: `background: var(--panel)`
- border: `1px solid var(--border)`
- radius: 14px

### 3.3 Message Row Content

Each MessageRow includes:
- header line (optional):
  - role label (“你” / “她”)
  - timestamp (muted)
- message bubble body (markdown render)
- message actions on hover:
  - Copy message
  - (Assistant only) Copy as Markdown
  - (Assistant only) Retry (if error)

### 3.4 Markdown Requirements
- Must render:
  - paragraphs, lists, quotes
  - inline code
  - fenced code blocks with language
  - links (open externally)
- Must be safe:
  - sanitize HTML
  - disallow script tags, inline events, iframes

Recommended libs:
- `marked` + `dompurify` (vanilla)
- OR `react-markdown` + `rehype-sanitize` (React)

### 3.5 Code Block UI
For fenced blocks:
- show top bar with:
  - language label (if exists)
  - Copy button
- code area:
  - monospace font: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
  - background: `var(--panel)`
  - border: 1px solid var(--border)
  - radius: 12px
  - horizontal scroll for long lines
- Optional: syntax highlight
  - If easy, use `highlight.js` or `shiki`.
  - Not required for MVP; prioritize copy + layout.

### 3.6 Link Handling
- Renderer must prevent `target=_blank` security issues:
  - use `shell.openExternal(url)` in Electron preload bridge.
- In markdown renderer: intercept link clicks and route to openExternal.

---

## 4) Composer (ChatGPT-like Input)

### 4.1 Behavior
- Multiline textarea
- Keyboard:
  - **Enter** → send
  - **Shift+Enter** → newline
  - **Ctrl+Enter** → newline (optional)
  - **Esc** → blur input (optional)
- Send button:
  - disabled when draft is empty/whitespace
  - shows spinner when sending/streaming
- Draft persistence:
  - store to `localStorage` every 500ms debounce
  - restore on reload

### 4.2 UI Elements
Composer area:
- left icon button: `+` (disabled placeholder)
- textarea
- right: send button

Under textarea:
- helper text: “Enter 发送 · Shift+Enter 换行”
- character counter optional (not required)

### 4.3 Height Auto-grow
- textarea grows with content up to max height 180px
- after max, textarea becomes scrollable
Implementation:
- set height to 0 then to `scrollHeight` on input

---

## 5) Sending Flow + Streaming (Core Integration)

### 5.1 IPC Events (Renderer -> Main)
- `CHAT_REQUEST` payload:
```ts
{ type: "CHAT_REQUEST"; ts: number; message: string; }
```

### 5.2 IPC Events (Main -> Renderer)

MVP (non-streaming) is acceptable:
- `CHAT_RESPONSE` payload:
```ts
{ type: "CHAT_RESPONSE"; ts: number; message: string; }
```

Preferred (streaming):
- `CHAT_STREAM_START` (id)
- `CHAT_STREAM_DELTA` (id, delta)
- `CHAT_STREAM_END` (id)

If streaming is implemented:
- On start: add assistant message with status=streaming and empty content
- On delta: append to content
- On end: set status=sent

### 5.3 “Typing…” Indicator
Show typing indicator when:
- a user message was sent AND no assistant response yet OR streaming ongoing
Implementation:
- `isStreaming` true OR “pendingResponse” true

Typing indicator design:
- three dots animation
- small pill bubble aligned left (assistant)

---

## 6) Scrolling & Auto-Follow (Very Important)

### 6.1 Default
- When new messages arrive, timeline auto-scrolls to bottom **only if** user is already near bottom.

### 6.2 Scroll Lock
Define:
- if user scrolls up more than 120px from bottom → `scrollLock=true`
- when `scrollLock=true`, do NOT auto-scroll
- show a “Jump to bottom” floating button at bottom-right of timeline

### 6.3 Jump to Bottom Button
- visible only when scrollLock=true
- clicking scrolls to bottom and sets scrollLock=false

Implementation detail:
- Use `scrollHeight - (scrollTop + clientHeight)`

---

## 7) Error Handling UX

### 7.1 Send Errors
If `CHAT_REQUEST` fails or response is error:
- Mark assistant message as `status="error"`
- Show error line: “请求失败”
- Provide “重试” button on that message

### 7.2 Toasts
Implement a lightweight toast system:
- top-right
- auto-dismiss 3s
Use for:
- “已复制”
- “网络错误”
- “API Key 未配置”

---

## 8) Accessibility & Polish

- Focus ring visible for textarea and buttons
- Copy buttons have aria-label
- Reduce motion: respect `prefers-reduced-motion`

---

## 9) File Plan (Codex MUST Create)

If React:
```
renderer/chat/
  App.tsx
  components/
    Timeline.tsx
    MessageRow.tsx
    Markdown.tsx
    CodeBlock.tsx
    Composer.tsx
    TypingIndicator.tsx
    JumpToBottom.tsx
    ToastHost.tsx
  styles/
    chat.css
    code.css
```

If Vanilla TS:
```
renderer/chat/
  app.ts
  timeline.ts
  messageRow.ts
  markdown.ts
  codeBlock.ts
  composer.ts
  typing.ts
  scroll.ts
  toast.ts
  styles/
    chat.css
    code.css
```

Preload bridge MUST expose:
- `openExternal(url)`
- `clipboardWrite(text)`
- `chatRequest(message)` + event listeners for responses

---

## 10) Definition of Done (Manual Checklist)

1. User right aligned, assistant left aligned
2. Markdown renders correctly (lists, code blocks)
3. Code blocks have copy button and horizontal scroll
4. Enter sends, Shift+Enter newline
5. Draft persists on reload
6. Scroll lock + jump-to-bottom works
7. Typing indicator shows while waiting
8. Copy actions show toast “已复制”
9. Links open externally (Electron shell)

---

## END SPEC
