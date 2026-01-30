import React from "react";
import samaAvatar from "../assets/sama-avatar.png";

export function TypingIndicator() {
  return (
    <div className="chatMessage assistant typing" role="status" aria-label="SAMA 正在输入">
      {/* Avatar */}
      <div className="chatAvatar">
        <img src={samaAvatar} alt="SAMA" className="avatarImg" />
      </div>

      {/* Bubble */}
      <div className="chatBubble">
        <div className="bubbleContent">
          <div className="typingIndicator" aria-label="正在输入">
            <span className="typingDot" />
            <span className="typingDot" />
            <span className="typingDot" />
          </div>
        </div>
      </div>
    </div>
  );
}
