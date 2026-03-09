import { useState, useCallback } from 'react';
import { Token } from '../types/swap';
import { DEFAULT_TOKENS } from '../lib/tokens';

export function useTokenSearch() {
  const [results, setResults] = useState<Token[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const search = useCallback(async (query: string) => {
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }

    setIsSearching(true);

    try {
      // Local fallback token list filter using defaults logic
      const filtered = DEFAULT_TOKENS.filter(
        t => t.symbol.toLowerCase().includes(query.toLowerCase()) ||
             t.name.toLowerCase().includes(query.toLowerCase())
      );
      
      // If we wanted external searching we'd hit Alchemy or our backend API here
      // For immediate response, return local matches
      setResults(filtered);
    } catch {
      // Return empty safely
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  return {
    results,
    isSearching,
    search,
    clear: () => setResults([]),
  };
}
