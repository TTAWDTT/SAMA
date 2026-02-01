import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Lightning bolt icon
function BoltIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

// Close icon for tags
function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// Search icon
function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export type ToolInfo = {
  name: string;
  title?: string;
  description?: string;
};

export type SkillInfo = {
  name: string;
  description?: string;
};

export type SelectedItem = {
  type: "tool" | "skill";
  name: string;
};

type Props = {
  tools: ToolInfo[];
  skills: SkillInfo[];
  selectedItems: SelectedItem[];
  onSelectionChange: (items: SelectedItem[]) => void;
  disabled?: boolean;
};

export function SkillToolSelector({ tools, skills, selectedItems, onSelectionChange, disabled }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close panel when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen]);

  const selectedSet = useMemo(() => {
    const set = new Set<string>();
    for (const item of selectedItems) {
      set.add(`${item.type}:${item.name}`);
    }
    return set;
  }, [selectedItems]);

  const toggleItem = useCallback(
    (type: "tool" | "skill", name: string) => {
      const key = `${type}:${name}`;
      if (selectedSet.has(key)) {
        onSelectionChange(selectedItems.filter((i) => !(i.type === type && i.name === name)));
      } else {
        onSelectionChange([...selectedItems, { type, name }]);
      }
    },
    [selectedItems, selectedSet, onSelectionChange]
  );

  const removeItem = useCallback(
    (type: "tool" | "skill", name: string) => {
      onSelectionChange(selectedItems.filter((i) => !(i.type === type && i.name === name)));
    },
    [selectedItems, onSelectionChange]
  );

  // Filter by search
  const filteredTools = useMemo(() => {
    if (!search.trim()) return tools;
    const q = search.toLowerCase();
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.description && t.description.toLowerCase().includes(q))
    );
  }, [tools, search]);

  const filteredSkills = useMemo(() => {
    if (!search.trim()) return skills;
    const q = search.toLowerCase();
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q))
    );
  }, [skills, search]);

  const hasItems = tools.length > 0 || skills.length > 0;

  return (
    <>
      {/* Selected items bar - shown above composer when items are selected */}
      {selectedItems.length > 0 && (
        <div className="selectedItemsBar">
          {selectedItems.map((item) => (
            <span key={`${item.type}:${item.name}`} className={`selectedTag ${item.type}`}>
              <span className="selectedTagType">{item.type === "tool" ? "T" : "S"}</span>
              <span className="selectedTagName">{item.name}</span>
              <button
                type="button"
                className="selectedTagRemove"
                onClick={() => removeItem(item.type, item.name)}
                aria-label={`移除 ${item.name}`}
              >
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Selector button */}
      <button
        ref={buttonRef}
        type="button"
        className={`composerSkillBtn ${isOpen ? "active" : ""} ${selectedItems.length > 0 ? "hasSelection" : ""}`}
        onClick={() => setIsOpen((v) => !v)}
        disabled={disabled || !hasItems}
        aria-label="选择工具/技能"
        title="选择工具/技能"
      >
        <BoltIcon />
        {selectedItems.length > 0 && <span className="selectionBadge">{selectedItems.length}</span>}
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div ref={panelRef} className="skillToolPanel">
          {/* Search input */}
          <div className="skillToolSearch">
            <SearchIcon />
            <input
              type="text"
              className="skillToolSearchInput"
              placeholder="搜索..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>

          <div className="skillToolList">
            {/* Tools section */}
            {filteredTools.length > 0 && (
              <div className="skillToolGroup">
                <div className="skillToolGroupTitle">Tools</div>
                {filteredTools.map((tool) => {
                  const isSelected = selectedSet.has(`tool:${tool.name}`);
                  return (
                    <button
                      key={tool.name}
                      type="button"
                      className={`skillToolItem ${isSelected ? "selected" : ""}`}
                      onClick={() => toggleItem("tool", tool.name)}
                    >
                      <span className="skillToolItemCheck">{isSelected ? "✓" : ""}</span>
                      <span className="skillToolItemInfo">
                        <span className="skillToolItemName">{tool.title || tool.name}</span>
                        {tool.description && <span className="skillToolItemDesc">{tool.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Skills section */}
            {filteredSkills.length > 0 && (
              <div className="skillToolGroup">
                <div className="skillToolGroupTitle">Skills</div>
                {filteredSkills.map((skill) => {
                  const isSelected = selectedSet.has(`skill:${skill.name}`);
                  return (
                    <button
                      key={skill.name}
                      type="button"
                      className={`skillToolItem ${isSelected ? "selected" : ""}`}
                      onClick={() => toggleItem("skill", skill.name)}
                    >
                      <span className="skillToolItemCheck">{isSelected ? "✓" : ""}</span>
                      <span className="skillToolItemInfo">
                        <span className="skillToolItemName">{skill.name}</span>
                        {skill.description && <span className="skillToolItemDesc">{skill.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Empty state */}
            {filteredTools.length === 0 && filteredSkills.length === 0 && (
              <div className="skillToolEmpty">
                {search ? "未找到匹配项" : "暂无可用工具或技能"}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
