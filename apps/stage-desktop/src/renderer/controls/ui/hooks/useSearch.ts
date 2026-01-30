import { useCallback, useEffect, useMemo, useState } from "react";

export type SearchMatch = {
  index: number;
  id: string;
};

export type UseSearchOptions = {
  debounceMs?: number;
};

export type UseSearchResult = {
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  debouncedQuery: string;
  matches: SearchMatch[];
  currentMatch: number;
  goToNext: () => void;
  goToPrev: () => void;
  goToMatch: (index: number) => void;
  clearSearch: () => void;
};

/**
 * Custom hook for search functionality with debouncing and navigation.
 */
export function useSearch<T extends { id: string; content: string }>(
  items: T[],
  options: UseSearchOptions = {}
): UseSearchResult {
  const { debounceMs = 150 } = options;

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [searchQuery, debounceMs]);

  // Reset current match when query changes
  useEffect(() => {
    setCurrentMatch(0);
  }, [debouncedQuery]);

  // Calculate matches
  const matches = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    const query = debouncedQuery.toLowerCase();
    const result: SearchMatch[] = [];
    items.forEach((item, index) => {
      if (item.content.toLowerCase().includes(query)) {
        result.push({ index, id: item.id });
      }
    });
    return result;
  }, [items, debouncedQuery]);

  // Navigate to a specific match
  const goToMatch = useCallback(
    (matchIndex: number) => {
      if (matches.length === 0) return;
      const safeIndex = ((matchIndex % matches.length) + matches.length) % matches.length;
      setCurrentMatch(safeIndex);

      const match = matches[safeIndex];
      if (match) {
        const el = document.getElementById(`msg-${match.id}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("searchHighlight");
          setTimeout(() => el.classList.remove("searchHighlight"), 2000);
        }
      }
    },
    [matches]
  );

  const goToNext = useCallback(() => {
    goToMatch(currentMatch + 1);
  }, [currentMatch, goToMatch]);

  const goToPrev = useCallback(() => {
    goToMatch(currentMatch - 1);
  }, [currentMatch, goToMatch]);

  const clearSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setDebouncedQuery("");
    setCurrentMatch(0);
  }, []);

  return {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    debouncedQuery,
    matches,
    currentMatch,
    goToNext,
    goToPrev,
    goToMatch,
    clearSearch
  };
}
