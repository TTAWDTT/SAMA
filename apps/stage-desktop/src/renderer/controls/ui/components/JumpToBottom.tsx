import React, { memo } from "react";

export const JumpToBottom = memo(function JumpToBottom(props: { onClick: () => void }) {
  return (
    <button className="jumpBtn" type="button" onClick={props.onClick} aria-label="跳到底部">
      <span className="jumpIcon" aria-hidden="true">↓</span>
      <span>跳到底部</span>
    </button>
  );
});

