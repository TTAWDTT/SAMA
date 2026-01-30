import React, { useEffect } from "react";

type ImageViewerProps = {
  src: string | null;
  onClose: () => void;
};

export function ImageViewer(props: ImageViewerProps) {
  const { src, onClose } = props;

  useEffect(() => {
    if (!src) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div
      className="imageViewerOverlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
    >
      <img
        src={src}
        alt="查看图片"
        className="imageViewerContent"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
