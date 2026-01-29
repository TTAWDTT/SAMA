import React from "react";

export function JumpToBottom(props: { onClick: () => void }) {
  return (
    <button className="jumpBtn" type="button" onClick={props.onClick} aria-label="Jump to bottom">
      <span className="jumpIcon" aria-hidden="true">↓</span>
      <span>跳到底部</span>
    </button>
  );
}

