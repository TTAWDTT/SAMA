import React from "react";

export function TypingIndicator() {
  return (
    <div className="chatMessage assistant typing">
      {/* Avatar */}
      <div className="chatAvatar">
        <div className="avatarCircle assistant">
          <span className="avatarEmoji">✨</span>
        </div>
      </div>

      {/* Content */}
      <div className="chatContent">
        <div className="chatHeader">
          <span className="chatName">SAMA</span>
          <span className="chatTime">正在思考...</span>
        </div>
        <div className="typingIndicator" aria-label="正在输入">
          <span className="typingDot" />
          <span className="typingDot" />
          <span className="typingDot" />
        </div>
      </div>
    </div>
  );
}
