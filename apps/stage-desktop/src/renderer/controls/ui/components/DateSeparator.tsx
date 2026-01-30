import React, { memo } from "react";

export const DateSeparator = memo(function DateSeparator(props: { date: string }) {
  return (
    <div className="dateSeparator">
      <span className="dateSeparatorText">{props.date}</span>
    </div>
  );
});

/**
 * Format a timestamp to a readable date string
 */
export function formatDateSeparator(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgDate.getTime() === today.getTime()) {
    return "今天";
  } else if (msgDate.getTime() === yesterday.getTime()) {
    return "昨天";
  } else if (now.getFullYear() === date.getFullYear()) {
    // Same year, show month and day
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  } else {
    // Different year, show full date
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }
}

/**
 * Get a date key for grouping messages
 */
export function getDateKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
