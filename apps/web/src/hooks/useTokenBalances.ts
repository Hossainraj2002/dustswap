import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useBalance, useReadContracts } from 'wagmi';
import { erc20Abi, type Address } from 'viem';
import { Token } from '../types/swap';
import { DEFAULT_TOKENS, NATIVE_ETH } from '../lib/tokens';
import { formatTokenAmount } from '../lib/utils';

const ERC20_DEFAULT_TOKENS = DEFAULT_TOKENS.filter(t => t.address !== NATIVE_ETH);
const ALCHEMY_ENDPOINT = `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || 'CmdIEko83a7OZB_9K6zAn'}`;

export function useTokenBalances() {
  const { address, isConnected } = useAccount();
  const [tokens, setTokens] = useState<Token[]>(DEFAULT_TOKENS);
  const [isLoading, setIsLoading] = useState(false);

  // Wagmi query for ETH balance
  const { data: ethBalance, refetch: refetchEth } = useBalance({
    address,
    query: {
      enabled: !!address,
      refetchInterval: 12000, // 12 seconds block time
    },
  });

  // ERC20 read contracts for default tokens
  const _erc20Contracts = useMemo(() => {
    return ERC20_DEFAULT_TOKENS.map(token => ({
      address: token.address as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: address ? [address as Address] : undefined,
    }));
  }, [address]);

  const { data: erc20Balances, refetch: refetchErc20 } = useReadContracts({
    contracts: _erc20Contracts,
    query: {
      enabled: !!address,
      refetchInterval: 12000, // 12 seconds block time
    }
  });

  // Fetch from Alchemy for other tokens
  const fetchAlchemyTokens = useCallback(async () => {
    if (!address) return [];
    try {
      const response = await fetch(ALCHEMY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'alchemy_getTokenBalances',
          params: [address, 'erc20'],
          id: 1
        })
      });
      
      const data = await response.json();
      if (!data.result || !data.result.tokenBalances) return [];
      
      // Filter > 0 balance
      const validTokens = data.result.tokenBalances.filter((t: any) => {
        const bal = BigInt(t.tokenBalance || '0');
        return bal > 0n;
      });
      
      // Prevent rate limiting (max 15 distinct metadata calls)
      const subsetTokens = validTokens.slice(0, 15);

      // Fetch metadata for these tokens
      const metadataPromises = subsetTokens.map(async (t: any) => {
        try {
          const metaRes = await fetch(ALCHEMY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'alchemy_getTokenMetadata',
              params: [t.contractAddress],
              id: 1
            })
          });
          const metaData = await metaRes.json();
          if (!metaData.result) return null;
          
          return {
            address: t.contractAddress as Address,
            symbol: metaData.result.symbol || '???',
            name: metaData.result.name || 'Unknown',
            decimals: metaData.result.decimals || 18,
            logoURI: metaData.result.logo || undefined,
            balance: BigInt(t.tokenBalance)
          } as Token;
        } catch {
          return null;
        }
      });
      
      const resolvedMetadata = await Promise.all(metadataPromises);
      return resolvedMetadata.filter(Boolean) as Token[];
    } catch (err) {
      console.warn('Failed Alchemy token fetch', err);
      return [];
    }
  }, [address]);

  const updateBalances = useCallback(async () => {
    if (!isConnected || !address) {
      setTokens(DEFAULT_TOKENS);
      return;
    }
    
    setIsLoading(true);
    
    // Default tokens mapping
    const processedDefaults = DEFAULT_TOKENS.map((token) => {
      if (token.address === NATIVE_ETH) {
        return {
          ...token,
          balance: ethBalance?.value || 0n,
          balanceFormatted: ethBalance ? ethBalance.formatted : '0',
        };
      }
      
      // For ERC20 defaults
      const index = ERC20_DEFAULT_TOKENS.findIndex(t => t.address === token.address);
      const balance = (erc20Balances && erc20Balances[index]?.result) as bigint | undefined;
      const finalBalance = balance || 0n;
      
      return {
        ...token,
        balance: finalBalance,
        balanceFormatted: finalBalance > 0n ? formatTokenAmount(finalBalance, token.decimals) : '0',
      };
    });

    try {
      // Get other tokens
      const otherTokens = await fetchAlchemyTokens();
      
      // Filter out tokens already in defaults
      const defaultAddresses = new Set(processedDefaults.map(t => t.address.toLowerCase()));
      const uniqueOthers = otherTokens.filter(t => !defaultAddresses.has(t.address.toLowerCase()));
      
      // Format others
      const formattedOthers = uniqueOthers.map(t => ({
        ...t,
        balanceFormatted: t.balance && t.balance > 0n ? formatTokenAmount(t.balance, t.decimals) : '0'
      }));
      
      // Sort others by balance strictly descending
      formattedOthers.sort((a, b) => {
        if (!a.balance || !b.balance) return 0;
        return a.balance > b.balance ? -1 : 1;
      });

      setTokens([...processedDefaults, ...formattedOthers]);
    } catch (e) {
      // Fallback
      setTokens(processedDefaults);
    } finally {
      setIsLoading(false);
    }
  }, [address, isConnected, ethBalance, erc20Balances, fetchAlchemyTokens]);

  useEffect(() => {
    updateBalances();
  }, [updateBalances]);

  const refetchAll = useCallback(() => {
    refetchEth();
    refetchErc20();
    updateBalances();
  }, [refetchEth, refetchErc20, updateBalances]);

  // Expose a quick balance getter to avoid prop drilling
  const getBalance = useCallback((tokenAddress: Address) => {
    const t = tokens.find(tk => tk.address.toLowerCase() === tokenAddress.toLowerCase());
    return t?.balance || 0n;
  }, [tokens]);

  return { tokens, isLoading, refetch: refetchAll, getBalance };
}
