import React from "react";

export function JumpToBottom(props: { onClick: () => void }) {
  return (
    <button className="jumpBtn" type="button" onClick={props.onClick} aria-label="Jump to bottom">
      跳到底部
    </button>
  );
}

