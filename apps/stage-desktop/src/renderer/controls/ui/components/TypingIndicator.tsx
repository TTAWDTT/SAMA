import React from "react";

export function TypingIndicator() {
  return (
    <div className="msgRow assistant">
      <div className="msgRowInner">
        <div className="typingBubble" aria-label="Typing">
          <span className="typingDot" />
          <span className="typingDot" />
          <span className="typingDot" />
        </div>
      </div>
    </div>
  );
}

