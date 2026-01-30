import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

// Send icon SVG
function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

// Image icon SVG
function ImageIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

// Close icon SVG
function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// Loading spinner
function LoadingSpinner() {
  return (
    <div className="loadingSpinner">
      <div className="spinnerRing" />
    </div>
  );
}

export type ImageAttachment = {
  dataUrl: string;
  name: string;
};

export function Composer(props: {
  value: string;
  busy: boolean;
  disabled?: boolean;
  onChange: (v: string) => void;
  onSend: (text: string, images?: ImageAttachment[]) => Promise<void> | void;
}) {
  const { value, busy, disabled, onChange, onSend } = props;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);

  const canSend = useMemo(() => !disabled && !busy && (Boolean(value.trim()) || images.length > 0), [disabled, busy, value, images]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(36, Math.min(120, el.scrollHeight))}px`;
  }, [value]);

  useEffect(() => {
    // Focus on first mount (Chat-first UX).
    inputRef.current?.focus();
  }, []);

  async function send() {
    const msg = value.trim();
    if (!msg && images.length === 0) return;
    if (busy) return;
    await onSend(msg, images.length > 0 ? images : undefined);
    setImages([]);
  }

  const handleImageSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setImages((prev) => {
          // Limit to 4 images
          if (prev.length >= 4) return prev;
          return [...prev, { dataUrl, name: file.name }];
        });
      };
      reader.onerror = () => {
        console.warn("Failed to read image file:", file.name);
      };
      reader.readAsDataURL(file);
    });

    // Reset input
    e.target.value = "";
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  // Handle paste event for images
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;

    // Prevent default only if we're handling images
    e.preventDefault();

    imageItems.forEach((item) => {
      const file = item.getAsFile();
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setImages((prev) => {
          // Limit to 4 images
          if (prev.length >= 4) return prev;
          return [...prev, { dataUrl, name: file.name || `pasted-${Date.now()}.png` }];
        });
      };
      reader.onerror = () => {
        console.warn("Failed to read pasted image");
      };
      reader.readAsDataURL(file);
    });
  };

  return (
    <div className="composerArea">
      <div className="composerContainer">
        {/* Image previews */}
        {images.length > 0 && (
          <div className="composerImagePreviews">
            {images.map((img, i) => (
              <div key={i} className="composerImagePreview">
                <img src={img.dataUrl} alt={img.name} />
                <button
                  type="button"
                  className="composerImageRemove"
                  onClick={() => removeImage(i)}
                  aria-label="移除图片"
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composerBox">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={handleFileChange}
          />

          {/* Image button */}
          <button
            type="button"
            className="composerImageBtn"
            onClick={handleImageSelect}
            disabled={Boolean(disabled) || busy || images.length >= 4}
            aria-label="添加图片"
            title="添加图片（最多4张）"
          >
            <ImageIcon />
          </button>

          <textarea
            ref={inputRef}
            className="composerTextarea"
            value={value}
            placeholder="发送消息..."
            spellCheck={false}
            disabled={Boolean(disabled)}
            onChange={(e) => onChange(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                (e.target as HTMLTextAreaElement).blur();
                return;
              }
              if (e.key !== "Enter") return;
              // Shift+Enter or Ctrl+Enter: newline
              if (e.shiftKey || e.ctrlKey) return;
              e.preventDefault();
              void send();
            }}
          />

          <button
            className={`sendButton ${canSend ? "active" : ""} ${busy ? "loading" : ""}`}
            type="button"
            disabled={!canSend}
            onClick={() => void send()}
            aria-label="发送"
          >
            {busy ? <LoadingSpinner /> : <SendIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}
