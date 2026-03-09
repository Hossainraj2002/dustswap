import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Token } from '../../types/swap';
import { formatSwapAmount } from '../../lib/utils';

interface TokenSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (token: Token) => void;
  excludeToken?: Token | null;
  title?: string;
  userTokens: Token[];
  defaultTokens: Token[];
  searchResults: Token[];
  isSearching: boolean;
  onSearch: (query: string) => void;
  onClearSearch: () => void;
}

export function TokenSelectorModal({
  isOpen,
  onClose,
  onSelect,
  excludeToken,
  title = 'Select a token',
  userTokens,
  defaultTokens,
  searchResults,
  isSearching,
  onSearch,
  onClearSearch
}: TokenSelectorModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
    if (!isOpen) {
      setSearchQuery('');
      onClearSearch();
    }
  }, [isOpen, onClearSearch]);

  useEffect(() => {
    if (searchQuery.length > 0) {
      onSearch(searchQuery);
    } else {
      onClearSearch();
    }
  }, [searchQuery, onSearch, onClearSearch]);

  const handleSelect = (token: Token) => {
    onSelect(token);
    onClose();
  };

  // Prevent background scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  const renderTokenList = (tokens: Token[], emptyMessage: string) => {
    const filtered = tokens.filter(t => t.address.toLowerCase() !== excludeToken?.address?.toLowerCase());
    
    if (filtered.length === 0) {
      return <div className="p-8 text-center text-gray-500 font-medium">{emptyMessage}</div>;
    }

    return (
      <div className="flex flex-col">
        {filtered.map(token => (
          <button
            key={token.address}
            onClick={() => handleSelect(token)}
            className="flex items-center justify-between p-4 hover:bg-[#1B2236] transition-colors min-h-[56px] w-full text-left group"
          >
            <div className="flex items-center gap-4">
              {token.logoURI ? (
                <img src={token.logoURI} alt={token.symbol} className="w-10 h-10 rounded-full" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white font-bold">
                  {token.symbol[0]}
                </div>
              )}
              <div className="flex flex-col">
                <span className="text-base font-semibold text-white group-hover:text-blue-400 transition-colors">
                  {token.symbol}
                </span>
                <span className="text-sm text-gray-500">{token.name}</span>
              </div>
            </div>
            
            {(token.balanceFormatted && token.balance && token.balance > 0n) ? (
              <div className="flex flex-col items-end">
                <span className="text-base font-medium text-white">
                  {formatSwapAmount(token.balanceFormatted, 6)}
                </span>
                {token.usdValue ? (
                  <span className="text-sm text-gray-500">
                    ${formatSwapAmount(token.usdValue, 2)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[100] flex sm:items-center justify-center safe-area-bottom">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={onClose} />
      
      {/* Modal View */}
      <div className="relative w-full sm:w-[480px] h-[90dvh] sm:h-[80vh] sm:max-h-[800px] mt-auto sm:mt-0 bg-[#0D111C] sm:rounded-3xl sm:border border-[#1B2236] rounded-t-[24px] flex flex-col shadow-2xl animate-in slide-in-from-bottom">
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#1B2236]">
          <h2 className="text-lg font-bold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-[#1B2236] transition-colors"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-[#1B2236]">
          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name or paste address"
              className="w-full bg-[#131A2A] border border-[#1B2236] rounded-[16px] px-4 py-3 pl-11 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 text-base"
              style={{ fontSize: '16px' }} // prevent iOS zoom
            />
            <svg className="absolute left-4 top-1/2 -mt-2.5 w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* List Section */}
        <div className="flex-1 overflow-y-auto overscroll-contain pb-safe">
          {searchQuery ? (
            <div className="py-2">
              <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Search Results</div>
              {isSearching ? (
                <div className="p-8 text-center text-gray-500">Searching...</div>
              ) : (
                renderTokenList(searchResults, 'No tokens found.')
              )}
            </div>
          ) : (
            <>
              {/* Default Popular Tokens */}
              <div className="py-2">
                <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Popular</div>
                {renderTokenList(defaultTokens, '')}
              </div>
              
              {/* User tokens (subtracting defaults if they overlap happens in parent or hook usually, we'll just render here) */}
              <div className="py-2 border-t border-[#1B2236]">
                <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Your Tokens</div>
                {renderTokenList(
                  userTokens.filter(t => !defaultTokens.some(dt => dt.address === t.address)), 
                  'No additional tokens found in wallet.'
                )}
              </div>
            </>
          )}
        </div>
        
      </div>
    </div>
  );
}
