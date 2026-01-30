import React, { useRef, useEffect } from "react";

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export type SearchBarProps = {
  isOpen: boolean;
  onClose: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  matchCount: number;
  currentMatch: number;
  onPrevMatch: () => void;
  onNextMatch: () => void;
};

export function SearchBar(props: SearchBarProps) {
  const { isOpen, onClose, searchQuery, onSearchChange, matchCount, currentMatch, onPrevMatch, onNextMatch } = props;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter") {
        if (e.shiftKey) {
          onPrevMatch();
        } else {
          onNextMatch();
        }
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, onPrevMatch, onNextMatch]);

  if (!isOpen) return null;

  return (
    <div className="searchBar">
      <div className="searchInputWrap">
        <span className="searchIcon"><SearchIcon /></span>
        <input
          ref={inputRef}
          type="text"
          className="searchInput"
          placeholder="搜索消息..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label="搜索消息"
        />
        {searchQuery && (
          <span className="searchCount">
            {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : "无结果"}
          </span>
        )}
      </div>
      <div className="searchActions">
        <button
          className="searchNavBtn"
          type="button"
          onClick={onPrevMatch}
          disabled={matchCount === 0}
          aria-label="上一个"
          title="上一个 (Shift+Enter)"
        >
          <ChevronUpIcon />
        </button>
        <button
          className="searchNavBtn"
          type="button"
          onClick={onNextMatch}
          disabled={matchCount === 0}
          aria-label="下一个"
          title="下一个 (Enter)"
        >
          <ChevronDownIcon />
        </button>
        <button
          className="searchCloseBtn"
          type="button"
          onClick={onClose}
          aria-label="关闭搜索"
          title="关闭 (Esc)"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
